export async function* readLines(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
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
    reader.releaseLock();
  }
}
