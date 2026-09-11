import { useEffect, useRef, useState } from 'react';
import { TerminalOutputStream, type TerminalOutputSource } from '@/terminal/output-stream';
import type { TerminalAttachmentMode, TerminalNotification, TerminalSummary } from '@weave/product-protocol';
import { type DirectHostClient } from '@/portal-client';
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
> & Partial<Pick<DirectHostClient, 'historyTerminal'>>;

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
  output?: TerminalOutputSource;
  loading: boolean;
  readOnlyReason?: string;
  error?: string;
};

type ActiveAttachment = {
  scopeKey: string;
  executionContextId: string;
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
  loading: false,
});

export function useAlphaTerminals({
  target,
  client,
  onExit,
}: {
  onExit?: (terminalId: string) => void;
  target?: AlphaTerminalTarget;
  client?: AlphaTerminalClient;
}) {
  const [model, setModel] = useState<AlphaTerminalsModel>(() => emptyModel(target));
  const requestedScopeKeysRef = useRef(new Set<string>());
  const preferredTerminalIdsRef = useRef(new Map<string, string>());
  const attachmentRef = useRef<ActiveAttachment | undefined>(undefined);
  const onExitRef = useRef(onExit); onExitRef.current = onExit;
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
    ? JSON.stringify([scopeKey, target.scope.executionContextId, target.supported, target.terminalId])
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
        attachment.executionContextId,
        attachment.terminalId,
        attachment.attachmentId,
      )
      .catch(() => undefined);
  };

  const historyTokenRef = useRef<string | undefined>(undefined);
  const restoreHistory = (token?: string, pages = 0) => {
    historyTokenRef.current = token;
    const active = attachmentRef.current;
    if (!token || !pages || !active?.client.historyTerminal) return;
    void (async () => {
      try {
        for (let page = 0; page < pages; page++) {
          if (!lifetime.alive || attachmentRef.current !== active || historyTokenRef.current !== token) return;
          const history = await active.client.historyTerminal!(active.executionContextId, active.terminalId, active.attachmentId, token, page);
          if (!lifetime.alive || attachmentRef.current !== active || historyTokenRef.current !== token) return;
          if (!await output.history(history.data)) return;
          if (history.finished) return;
        }
        throw new Error('Terminal history was truncated');
      } catch {
        if (lifetime.alive && attachmentRef.current === active && historyTokenRef.current === token) {
          output.clear(); void serialized(async () => { const terminal = model.tabs.find(t => t.terminalId === active.terminalId); if (terminal) await attach(terminal, 'shared'); });
        }
      }
    })();
  };

  const receive = (notification: TerminalNotification) => {
    const active = attachmentRef.current;
    if (!lifetime.alive || !active || active.attachmentId !== notification.attachmentId) return;
    const event = notification.event;
    if (event.type === 'output') { output.write(event.data); return; }
    if (event.type === 'screen') {
      output.reset(event.data, { cols: event.terminal.cols, rows: event.terminal.rows });
      restoreHistory(event.historyToken, event.historyPages);
      setModel((current) => ({ ...current, tabs: current.tabs.map((tab) => tab.terminalId === notification.terminalId ? event.terminal : tab) }));
      return;
    }
    if (event.type === 'exit' || event.type === 'resync') output.clear();
    if (event.type === 'exit' || event.type === 'resync') {
      const explicitClose = event.type === 'exit' &&
        closingRef.current.has(notification.terminalId);
      if (event.type === 'exit' && target?.terminalId) {
        attachmentRef.current = undefined;
        onExitRef.current?.(notification.terminalId);
      } else if (explicitClose) attachmentRef.current = undefined;
      else queueMicrotask(() => reconcileExitedRef.current(event.type === 'resync' ? active.terminalId : undefined));
    }
    setModel((current) => {
      if (current.activeTerminalId !== notification.terminalId) return current;
      if (event.type === 'directory') return { ...current, tabs: current.tabs.map((tab) => tab.terminalId === notification.terminalId ? { ...tab, currentDirectory: event.currentDirectory } : tab) };
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
          readOnlyReason: undefined,
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
    preferredMode: TerminalAttachmentMode = 'shared',
  ) => {
    if (!target || !client || !lifetime.alive) return;
    await detachCurrent();
    const attached = await client.attachTerminal(
      target.scope.executionContextId,
      terminal.terminalId,
      preferredMode,
      receive,
    );
    if (!lifetime.alive) {
      await client.detachTerminal(target.scope.executionContextId, terminal.terminalId, attached.attachment.attachmentId).catch(() => undefined);
      return;
    }
    attachmentRef.current = {
      scopeKey,
      executionContextId: target.scope.executionContextId,
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
    restoreHistory(attached.snapshot.historyToken, attached.snapshot.historyPages);
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
      loading: false,
      readOnlyReason: undefined,
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
      currentAttachment.executionContextId === target.scope.executionContextId &&
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
    const listed = await client.listTerminals(target.scope.executionContextId);
    if (!lifetime.alive) return;
    let tabs = listed.terminals.filter((terminal) => terminal.status === 'running');
    if (target.terminalId && !tabs.some((tab) => tab.terminalId === target.terminalId)) {
      await detachCurrent();
      setModel((current) => ({ ...current, tabs: [], loading: false, activeTerminalId: undefined, attachmentId: undefined, attachmentMode: undefined,
        error: undefined }));
      onExitRef.current?.(target.terminalId);
      return;
    }
    if (!tabs.length) {
      tabs = [(await client.createTerminal(target.scope.executionContextId)).terminal];
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
        const created = await client.createTerminal(target.scope.executionContextId);
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
    input: (data: string | Uint8Array) => {
      const attachment = attachmentRef.current;
      // Wait only for already queued lifecycle barriers. Successive keystrokes
      // may be in flight together; the ordered transport acknowledges progress.
      const barrier = operationRef.current;
      return barrier.then(async () => {
        if (!lifetime.alive || !attachment || attachmentRef.current !== attachment || attachment.mode === 'observe') return;
        await attachment.client.inputTerminal(attachment.executionContextId, attachment.terminalId, attachment.attachmentId, data);
      }).catch((cause) => {
        if (lifetime.alive && attachmentRef.current === attachment) setModel(current => ({ ...current, error: cause instanceof Error ? cause.message : 'Terminal input acceptance is uncertain; it was not replayed.' }));
      });
    },
    resize: (cols: number, rows: number) => {
      const attachment = attachmentRef.current;
      return serialized(async () => {
        if (!lifetime.alive || !attachment || attachmentRef.current !== attachment || attachment.mode === 'observe') return;
        await attachment.client.resizeTerminal(
          attachment.executionContextId,
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
        if (terminal) await attach(terminal, 'shared');
      }),
    close: (terminalId: string) =>
      serialized(async () => {
        const attachment = attachmentRef.current;
        if (
          !lifetime.alive ||
          !target ||
          !client ||
          !attachment ||
          attachment.mode === 'observe' ||
          attachment.terminalId !== terminalId
        ) {
          return;
        }
        closingRef.current.add(terminalId);
        try {
          await client.closeTerminal(
            target.scope.executionContextId,
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
        }));
        if (!target.terminalId && tabs[0] && requestedScopeKeysRef.current.has(scopeKey)) {
          await attach(tabs[0]);
        }
      }),
  };

  return { model: { ...model, output }, actions };
}
