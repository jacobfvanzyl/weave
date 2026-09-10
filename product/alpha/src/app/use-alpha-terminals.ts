import { useEffect, useRef, useState } from 'react';
import { TerminalOutputStream, type TerminalOutputSource } from '@/terminal/output-stream';
import type { TerminalAttachmentMode, TerminalNotification, TerminalSummary } from '@weave/product-protocol';
import { type DirectHostClient, PortalRpcError } from '@/portal-client';
import {
  type AlphaTerminalScope,
  alphaTerminalScopeKey,
} from './alpha-terminal-scope';

export type AlphaTerminalClient = Pick<
  DirectHostClient,
  | 'listTerminals'
  | 'createTerminal'
  | 'attachTerminal'
  | 'inputTerminal'
  | 'resizeTerminal'
  | 'detachTerminal'
  | 'closeTerminal'
>;

export type AlphaTerminalTarget = {
  scope: AlphaTerminalScope;
  supported: boolean;
  terminalId?: string;
};

export type AlphaTerminalsModel = {
  scope?: AlphaTerminalScope;
  supported: boolean;
  tabs: TerminalSummary[];
  activeTerminalId?: string;
  attachmentId?: string;
  attachmentMode?: TerminalAttachmentMode;
  /** Legacy preview data. Live attachments deliver bytes through output. */
  data: string;
  output?: TerminalOutputSource;
  dataEpoch: number;
  dataOffset: number;
  loading: boolean;
  readOnlyReason?: string;
  error?: string;
};

type ActiveAttachment = {
  scopeKey: string;
  workspaceId: string;
  terminalId: string;
  attachmentId: string;
  mode: TerminalAttachmentMode;
  client: AlphaTerminalClient;
};

const emptyModel = (
  target: AlphaTerminalTarget | undefined,
): AlphaTerminalsModel => ({
  scope: target?.scope,
  supported: target?.supported ?? false,
  tabs: [],
  data: '',
  dataEpoch: 0,
  dataOffset: 0,
  loading: false,
});

const controlledElsewhere = (cause: unknown) =>
  cause instanceof PortalRpcError &&
  (cause.data as { domain?: unknown; code?: unknown } | undefined)?.domain ===
    'terminal' &&
  (cause.data as { code?: unknown }).code === 'TERMINAL_CONTROLLED';

export function useAlphaTerminals({
  target,
  client,
}: {
  target?: AlphaTerminalTarget;
  client?: AlphaTerminalClient;
}) {
  const [model, setModel] = useState<AlphaTerminalsModel>(() => emptyModel(target));
  const requestedScopeKeysRef = useRef(new Set<string>());
  const preferredTerminalIdsRef = useRef(new Map<string, string>());
  const attachmentRef = useRef<ActiveAttachment | undefined>(undefined);
  const closingRef = useRef(new Set<string>());
  const reconcileExitedRef = useRef<(preferredTerminalId?: string) => void>(() => undefined);
  const operationRef = useRef(Promise.resolve());
  const [output] = useState(() => new TerminalOutputStream(() => {
    const active = attachmentRef.current;
    if (!active) return;
    setModel((current) => ({ ...current, attachmentId: undefined, attachmentMode: undefined, error: 'Terminal renderer fell behind. Reconnecting from a fresh snapshot.' }));
    queueMicrotask(() => reconcileExitedRef.current(active.terminalId));
  }));
  const scopeKey = target ? alphaTerminalScopeKey(target.scope) : '';
  const targetKey = target
    ? JSON.stringify([scopeKey, target.scope.workspaceId, target.supported, target.terminalId])
    : '';

  const lifetimeRef = useRef({ key: targetKey, client, alive: true });
  if (lifetimeRef.current.key !== targetKey || lifetimeRef.current.client !== client) {
    lifetimeRef.current.alive = false;
    lifetimeRef.current = { key: targetKey, client, alive: true };
  }
  const lifetime = lifetimeRef.current;

  const serialized = <Result>(operation: () => Promise<Result>) => {
    const result = operationRef.current.then(operation, operation);
    operationRef.current = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const detachCurrent = async () => {
    const attachment = attachmentRef.current;
    attachmentRef.current = undefined;
    if (!attachment) return;
    await attachment.client
      .detachTerminal(
        attachment.workspaceId,
        attachment.terminalId,
        attachment.attachmentId,
      )
      .catch(() => undefined);
  };

  const receive = (notification: TerminalNotification) => {
    const active = attachmentRef.current;
    if (!lifetime.alive || !active || active.attachmentId !== notification.attachmentId) return;
    const event = notification.event;
    if (event.type === 'output') { output.write(event.data); return; }
    if (event.type === 'exit' || event.type === 'resync') output.clear();
    if (event.type === 'exit' || event.type === 'resync') {
      const explicitClose = event.type === 'exit' &&
        closingRef.current.has(notification.terminalId);
      if (explicitClose) attachmentRef.current = undefined;
      else queueMicrotask(() => reconcileExitedRef.current(event.type === 'resync' ? active.terminalId : undefined));
    }
    setModel((current) => {
      if (current.activeTerminalId !== notification.terminalId) return current;
      if (event.type === 'title') {
        return {
          ...current,
          tabs: current.tabs.map((tab) =>
            tab.terminalId === notification.terminalId ? { ...tab, title: event.title } : tab
          ),
        };
      }
      if (event.type === 'exit') {
        return {
          ...current,
          tabs: current.tabs.filter(
            (tab) => tab.terminalId !== notification.terminalId,
          ),
          activeTerminalId: undefined,
          attachmentId: undefined,
          attachmentMode: undefined,
          data: '',
          dataEpoch: current.dataEpoch + 1,
          dataOffset: 0,
          readOnlyReason: undefined,
        };
      }
      if (
        event.type === 'control' &&
        !event.controlled &&
        active.mode === 'observe'
      ) {
        return {
          ...current,
          readOnlyReason: 'This Terminal is available for control again.',
        };
      }
      if (event.type === 'resync') {
        return {
          ...current,
          attachmentId: undefined,
          attachmentMode: undefined,
          readOnlyReason: undefined,
          error: 'Terminal output fell behind. Reconnecting from a fresh snapshot.',
        };
      }
      return current;
    });
  };

  const attach = async (
    terminal: TerminalSummary,
    preferredMode: TerminalAttachmentMode = 'control',
  ) => {
    if (!target || !client || !lifetime.alive) return;
    await detachCurrent();
    let attached;
    let readOnlyReason: string | undefined;
    try {
      attached = await client.attachTerminal(
        target.scope.workspaceId,
        terminal.terminalId,
        preferredMode,
        receive,
      );
    } catch (cause) {
      if (preferredMode !== 'control' || !controlledElsewhere(cause)) {
        throw cause;
      }
      attached = await client.attachTerminal(
        target.scope.workspaceId,
        terminal.terminalId,
        'observe',
        receive,
      );
      readOnlyReason = 'This Terminal is controlled from another attachment.';
    }
    if (!lifetime.alive) {
      await client.detachTerminal(target.scope.workspaceId, terminal.terminalId, attached.attachment.attachmentId).catch(() => undefined);
      return;
    }
    attachmentRef.current = {
      scopeKey,
      workspaceId: target.scope.workspaceId,
      terminalId: terminal.terminalId,
      attachmentId: attached.attachment.attachmentId,
      mode: attached.attachment.mode,
      client,
    };
    preferredTerminalIdsRef.current.set(
      scopeKey,
      attached.snapshot.terminal.terminalId,
    );
    output.reset(attached.snapshot.data, { cols: attached.snapshot.terminal.cols, rows: attached.snapshot.terminal.rows });
    setModel((current) => ({
      ...current,
      scope: target.scope,
      supported: true,
      tabs: current.tabs.some(
          ({ terminalId }) => terminalId === attached.snapshot.terminal.terminalId,
        )
        ? current.tabs.map((tab) =>
          tab.terminalId === attached.snapshot.terminal.terminalId ? attached.snapshot.terminal : tab
        )
        : [...current.tabs, attached.snapshot.terminal],
      activeTerminalId: attached.snapshot.terminal.terminalId,
      attachmentId: attached.attachment.attachmentId,
      attachmentMode: attached.attachment.mode,
      data: '',
      dataEpoch: current.dataEpoch + 1,
      dataOffset: 0,
      loading: false,
      readOnlyReason,
      error: undefined,
    }));
    attached.startEvents();
  };

  const ensureAttached = async (preferredTerminalId?: string) => {
    preferredTerminalId = target?.terminalId ?? preferredTerminalId;
    if (!target || !client || !target.supported) {
      setModel((current) => ({
        ...current,
        supported: false,
        loading: false,
        error: target
          ? 'This Portal must be updated before it can open Terminals.'
          : 'Open a terminal workspace to connect its panes.',
      }));
      return;
    }
    const currentAttachment = attachmentRef.current;
    if (
      currentAttachment?.scopeKey === scopeKey &&
      currentAttachment.workspaceId === target.scope.workspaceId &&
      (!preferredTerminalId || currentAttachment.terminalId === preferredTerminalId)
    ) {
      return;
    }
    setModel((current) => ({
      ...current,
      scope: target.scope,
      supported: true,
      loading: true,
      error: undefined,
    }));
    const listed = await client.listTerminals(target.scope.workspaceId);
    if (!lifetime.alive) return;
    let tabs = listed.terminals;
    if (target.terminalId && !tabs.some((tab) => tab.terminalId === target.terminalId)) {
      await detachCurrent();
      setModel((current) => ({ ...current, tabs: [], loading: false, activeTerminalId: undefined, attachmentId: undefined, attachmentMode: undefined,
        error: 'This terminal is unavailable. Its pane is retained; reconnect or explicitly start a replacement.' }));
      return;
    }
    if (!tabs.length) {
      tabs = [(await client.createTerminal(target.scope.workspaceId)).terminal];
    }
    const terminal = tabs.find(({ terminalId }) => terminalId === preferredTerminalId) ??
      tabs[0];
    setModel((current) => ({ ...current, tabs: target.terminalId ? tabs.filter((tab) => tab.terminalId === target.terminalId) : tabs }));
    await attach(terminal);
  };

  reconcileExitedRef.current = (preferredTerminalId) => {
    if (!requestedScopeKeysRef.current.has(scopeKey)) return;
    void serialized(async () => {
      await detachCurrent();
      await ensureAttached(target?.terminalId ?? preferredTerminalId);
    }).catch((cause) => {
      setModel((current) => ({
        ...current,
        loading: false,
        error: cause instanceof Error ? cause.message : String(cause),
      }));
    });
  };

  useEffect(() => {
    let disposed = false;
    const preferredTerminalId = preferredTerminalIdsRef.current.get(scopeKey);
    void serialized(async () => {
      await detachCurrent();
      if (disposed) return;
      output.clear();
      setModel(emptyModel(target));
      if (target?.terminalId || requestedScopeKeysRef.current.has(scopeKey)) {
        requestedScopeKeysRef.current.add(scopeKey);
        await ensureAttached(preferredTerminalId);
      }
    }).catch((cause) => {
      if (!disposed) {
        setModel((current) => ({
          ...current,
          loading: false,
          error: cause instanceof Error ? cause.message : String(cause),
        }));
      }
    });
    return () => {
      disposed = true;
    };
    // targetKey is the stable identity; individual object instances are not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey, client]);

  useEffect(() => {
    lifetimeRef.current.alive = true;
    return () => {
      lifetimeRef.current.alive = false;
      requestedScopeKeysRef.current.clear();
      output.clear();
      void detachCurrent();
    };
  }, []);

  const actions = {
    show: () =>
      serialized(async () => {
        if (!scopeKey) return;
        requestedScopeKeysRef.current.add(scopeKey);
        await ensureAttached(
          model.activeTerminalId ?? preferredTerminalIdsRef.current.get(scopeKey),
        );
      }),
    // Hiding the current scope is view-only, so its live attachment remains.
    // Clearing demand prevents it from being reattached after a scope change.
    hide: () => {
      if (scopeKey) requestedScopeKeysRef.current.delete(scopeKey);
      return Promise.resolve();
    },
    create: () =>
      serialized(async () => {
        if (!target || !client || !target.supported) return;
        const created = await client.createTerminal(target.scope.workspaceId);
        setModel((current) => ({
          ...current,
          tabs: [...current.tabs, created.terminal],
        }));
        await attach(created.terminal);
      }),
    select: (terminalId: string) =>
      serialized(async () => {
        const terminal = model.tabs.find(
          (tab) => tab.terminalId === terminalId,
        );
        if (terminal) await attach(terminal);
      }),
    input: (data: string) => {
      const attachment = attachmentRef.current;
      return serialized(async () => {
        if (!lifetime.alive || !attachment || attachmentRef.current !== attachment || attachment.mode !== 'control') return;
        await attachment.client.inputTerminal(
          attachment.workspaceId,
          attachment.terminalId,
          attachment.attachmentId,
          data,
        );
      });
    },
    resize: (cols: number, rows: number) => {
      const attachment = attachmentRef.current;
      return serialized(async () => {
        if (!lifetime.alive || !attachment || attachmentRef.current !== attachment || attachment.mode !== 'control') return;
        await attachment.client.resizeTerminal(
          attachment.workspaceId,
          attachment.terminalId,
          attachment.attachmentId,
          cols,
          rows,
        );
      });
    },
    retryControl: () =>
      serialized(async () => {
        const terminal = model.tabs.find(
          ({ terminalId }) => terminalId === model.activeTerminalId,
        );
        if (terminal) await attach(terminal, 'control');
      }),
    close: (terminalId: string) =>
      serialized(async () => {
        const attachment = attachmentRef.current;
        if (
          !lifetime.alive ||
          !target ||
          !client ||
          !attachment ||
          attachment.mode !== 'control' ||
          attachment.terminalId !== terminalId
        ) {
          return;
        }
        closingRef.current.add(terminalId);
        try {
          await client.closeTerminal(
            target.scope.workspaceId,
            terminalId,
            attachment.attachmentId,
          );
        } finally {
          closingRef.current.delete(terminalId);
        }
        attachmentRef.current = undefined;
        if (preferredTerminalIdsRef.current.get(scopeKey) === terminalId) {
          preferredTerminalIdsRef.current.delete(scopeKey);
        }
        const tabs = model.tabs.filter((tab) => tab.terminalId !== terminalId);
        setModel((current) => ({
          ...current,
          tabs,
          activeTerminalId: undefined,
          attachmentId: undefined,
          attachmentMode: undefined,
          data: '',
          dataEpoch: current.dataEpoch + 1,
          dataOffset: 0,
        }));
        if (!target.terminalId && tabs[0] && requestedScopeKeysRef.current.has(scopeKey)) {
          await attach(tabs[0]);
        }
      }),
  };

  return { model: { ...model, output }, actions };
}
