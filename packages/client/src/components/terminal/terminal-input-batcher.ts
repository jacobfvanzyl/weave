type TerminalInputBatchTimer = ReturnType<typeof setTimeout>;

export type TerminalInputBatchScheduler = {
  clearTimeout: (timer: TerminalInputBatchTimer) => void;
  setTimeout: (callback: () => void, delayMs: number) => TerminalInputBatchTimer;
};

const defaultScheduler: TerminalInputBatchScheduler = {
  clearTimeout: timer => globalThis.clearTimeout(timer),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
};

export const createTerminalInputBatcher = (
  emit: (data: string) => void,
  scheduler: TerminalInputBatchScheduler = defaultScheduler,
) => {
  let pendingInput = '';
  let timer: TerminalInputBatchTimer | undefined;

  const flush = () => {
    if (timer !== undefined) {
      scheduler.clearTimeout(timer);
      timer = undefined;
    }
    if (!pendingInput) return;

    const data = pendingInput;
    pendingInput = '';
    emit(data);
  };

  return {
    dispose: flush,
    flush,
    push: (data: string) => {
      if (!data) return;
      pendingInput += data;
      timer ??= scheduler.setTimeout(flush, 0);
    },
  };
};
