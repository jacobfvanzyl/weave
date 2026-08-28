import { useEffect, useRef, useState } from 'react';
import type { TerminalAttachmentMode, TerminalNotification, TerminalSummary } from '@weave/product-protocol';
import { type DirectHostClient, PortalRpcError } from '@/portal-client';

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
  hostId: string;
  workspaceId: string;
  supported: boolean;
};

export type AlphaTerminalsModel = {
  hostId?: string;
  workspaceId?: string;
  supported: boolean;
  tabs: TerminalSummary[];
  activeTerminalId?: string;
  attachmentId?: string;
  attachmentMode?: TerminalAttachmentMode;
  data: string;
  dataEpoch: number;
  dataOffset: number;
  loading: boolean;
  readOnlyReason?: string;
  error?: string;
};

type ActiveAttachment = {
  hostId: string;
  workspaceId: string;
  terminalId: string;
  attachmentId: string;
  mode: TerminalAttachmentMode;
};

const emptyModel = (
  target: AlphaTerminalTarget | undefined,
): AlphaTerminalsModel => ({
  hostId: target?.hostId,
  workspaceId: target?.workspaceId,
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

const MAX_RETAINED_TERMINAL_DATA = 1024 * 1024;

export function useAlphaTerminals({
  target,
  client,
}: {
  target?: AlphaTerminalTarget;
  client?: AlphaTerminalClient;
}) {
  const [model, setModel] = useState<AlphaTerminalsModel>(() => emptyModel(target));
  const requestedRef = useRef(false);
  const attachmentRef = useRef<ActiveAttachment | undefined>(undefined);
  const closingRef = useRef(new Set<string>());
  const reconcileExitedRef = useRef<(preferredTerminalId?: string) => void>(() => undefined);
  const operationRef = useRef(Promise.resolve());
  const activeTerminalIdRef = useRef(model.activeTerminalId);
  activeTerminalIdRef.current = model.activeTerminalId;
  const targetKey = target ? `${target.hostId}:${target.workspaceId}:${target.supported}` : '';

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
    if (!attachment || !client) return;
    await client
      .detachTerminal(
        attachment.workspaceId,
        attachment.terminalId,
        attachment.attachmentId,
      )
      .catch(() => undefined);
  };

  const receive = (notification: TerminalNotification) => {
    const active = attachmentRef.current;
    if (!active || active.attachmentId !== notification.attachmentId) return;
    const event = notification.event;
    if (event.type === 'exit' || event.type === 'resync') {
      const explicitClose = event.type === 'exit' &&
        closingRef.current.has(notification.terminalId);
      if (explicitClose) attachmentRef.current = undefined;
      else queueMicrotask(() => reconcileExitedRef.current(event.type === 'resync' ? active.terminalId : undefined));
    }
    setModel((current) => {
      if (current.activeTerminalId !== notification.terminalId) return current;
      if (event.type === 'output') {
        const combined = `${current.data}${event.data}`;
        const dropped = Math.max(0, combined.length - MAX_RETAINED_TERMINAL_DATA);
        return {
          ...current,
          data: dropped > 0 ? combined.slice(dropped) : combined,
          dataOffset: current.dataOffset + dropped,
        };
      }
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
    if (!target || !client) return;
    await detachCurrent();
    let attached;
    let readOnlyReason: string | undefined;
    try {
      attached = await client.attachTerminal(
        target.workspaceId,
        terminal.terminalId,
        preferredMode,
        receive,
      );
    } catch (cause) {
      if (preferredMode !== 'control' || !controlledElsewhere(cause)) {
        throw cause;
      }
      attached = await client.attachTerminal(
        target.workspaceId,
        terminal.terminalId,
        'observe',
        receive,
      );
      readOnlyReason = 'This Terminal is controlled from another attachment.';
    }
    attachmentRef.current = {
      hostId: target.hostId,
      workspaceId: target.workspaceId,
      terminalId: terminal.terminalId,
      attachmentId: attached.attachment.attachmentId,
      mode: attached.attachment.mode,
    };
    setModel((current) => ({
      ...current,
      hostId: target.hostId,
      workspaceId: target.workspaceId,
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
      data: attached.snapshot.data,
      dataEpoch: current.dataEpoch + 1,
      dataOffset: 0,
      loading: false,
      readOnlyReason,
      error: undefined,
    }));
    attached.startEvents();
  };

  const ensureAttached = async (preferredTerminalId?: string) => {
    if (!target || !client || !target.supported) {
      setModel((current) => ({
        ...current,
        supported: false,
        loading: false,
        error: target
          ? 'This Portal must be updated before it can open Terminals.'
          : 'Select a Thread to open its Workspace Terminals.',
      }));
      return;
    }
    const currentAttachment = attachmentRef.current;
    if (
      currentAttachment?.hostId === target.hostId &&
      currentAttachment.workspaceId === target.workspaceId &&
      (!preferredTerminalId || currentAttachment.terminalId === preferredTerminalId)
    ) {
      return;
    }
    setModel((current) => ({
      ...current,
      hostId: target.hostId,
      workspaceId: target.workspaceId,
      supported: true,
      loading: true,
      error: undefined,
    }));
    const listed = await client.listTerminals(target.workspaceId);
    let tabs = listed.terminals;
    if (!tabs.length) {
      tabs = [(await client.createTerminal(target.workspaceId)).terminal];
    }
    const terminal = tabs.find(({ terminalId }) => terminalId === preferredTerminalId) ??
      tabs[0];
    setModel((current) => ({ ...current, tabs }));
    await attach(terminal);
  };

  reconcileExitedRef.current = (preferredTerminalId) => {
    if (!requestedRef.current) return;
    void serialized(async () => {
      await detachCurrent();
      await ensureAttached(preferredTerminalId);
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
    const preferredTerminalId = activeTerminalIdRef.current;
    void serialized(async () => {
      await detachCurrent();
      if (disposed) return;
      setModel(emptyModel(target));
      if (requestedRef.current) await ensureAttached(preferredTerminalId);
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

  useEffect(
    () => () => {
      requestedRef.current = false;
      void detachCurrent();
    },
    [],
  );

  const actions = {
    show: () =>
      serialized(async () => {
        requestedRef.current = true;
        await ensureAttached(model.activeTerminalId);
      }),
    // Dock visibility is view-only. Keep the attachment (and controller
    // authority) alive until the target changes, the Terminal closes, the
    // transport requests a resync, or this controller is torn down.
    hide: () => Promise.resolve(),
    create: () =>
      serialized(async () => {
        if (!target || !client || !target.supported) return;
        const created = await client.createTerminal(target.workspaceId);
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
    input: (data: string) =>
      serialized(async () => {
        const attachment = attachmentRef.current;
        if (!attachment || attachment.mode !== 'control' || !client) return;
        await client.inputTerminal(
          attachment.workspaceId,
          attachment.terminalId,
          attachment.attachmentId,
          data,
        );
      }),
    resize: (cols: number, rows: number) =>
      serialized(async () => {
        const attachment = attachmentRef.current;
        if (!attachment || attachment.mode !== 'control' || !client) return;
        await client.resizeTerminal(
          attachment.workspaceId,
          attachment.terminalId,
          attachment.attachmentId,
          cols,
          rows,
        );
      }),
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
            target.workspaceId,
            terminalId,
            attachment.attachmentId,
          );
        } finally {
          closingRef.current.delete(terminalId);
        }
        attachmentRef.current = undefined;
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
        if (tabs[0] && requestedRef.current) await attach(tabs[0]);
      }),
  };

  return { model, actions };
}
