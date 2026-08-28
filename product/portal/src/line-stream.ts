export async function* readLines(stream: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  const abort = () => void reader.cancel(signal?.reason).catch(() => undefined);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffered += decoder.decode(value, { stream: !done });
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const line = buffered.slice(0, newline).replace(/\r$/, '');
        buffered = buffered.slice(newline + 1);
        yield line;
        newline = buffered.indexOf('\n');
      }
      if (done) break;
    }
    if (buffered) yield buffered.replace(/\r$/, '');
  } finally {
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
