export type BoundedLogWriter = {
  write: (level: string, values: unknown[]) => void;
  close: () => void;
};

const encodeValue = (value: unknown) => {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

export const createBoundedLogWriter = (path: string, maxBytes: number): BoundedLogWriter => {
  const byteLimit = Math.max(1_024, Math.floor(maxBytes));
  const encoder = new TextEncoder();
  const file = Deno.openSync(path, { append: true, create: true, write: true, mode: 0o600 });
  Deno.chmodSync(path, 0o600);
  let size = file.statSync().size;

  return {
    write: (level, values) => {
      let bytes = encoder.encode(`${new Date().toISOString()} ${level} ${values.map(encodeValue).join(' ')}\n`);
      if (bytes.byteLength > byteLimit) bytes = bytes.slice(bytes.byteLength - byteLimit);
      if (size + bytes.byteLength > byteLimit) {
        file.truncateSync(0);
        file.seekSync(0, Deno.SeekMode.Start);
        size = 0;
      }
      file.writeSync(bytes);
      size += bytes.byteLength;
    },
    close: () => file.close(),
  };
};

export const installBoundedConsoleLog = (path: string, maxBytes: number) => {
  const writer = createBoundedLogWriter(path, maxBytes);
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  console.log = (...values) => writer.write('INFO', values);
  console.info = (...values) => writer.write('INFO', values);
  console.warn = (...values) => writer.write('WARN', values);
  console.error = (...values) => writer.write('ERROR', values);
  console.debug = (...values) => writer.write('DEBUG', values);

  return () => {
    console.log = original.log;
    console.info = original.info;
    console.warn = original.warn;
    console.error = original.error;
    console.debug = original.debug;
    writer.close();
  };
};
