import { connect, type Socket } from 'node:net';
import { Readable, Writable } from 'node:stream';
export const stdinStream = () => Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
export const stdoutStream = () => Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;

// Socket teardown is a normal EOF for the connector. Avoid Duplex.toWeb's
// coupled readable/writable completion, which rejects both on local destruction.
export function localStream(socket: Socket) {
  let ended = false;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      const end = () => { if (!ended) { ended = true; controller.close(); } };
      socket.on('data', (data: Buffer) => {
        if (ended) return;
        controller.enqueue(new Uint8Array(data));
        if ((controller.desiredSize ?? 0) <= 0) socket.pause();
      });
      socket.once('end', end);
      socket.once('close', end);
      socket.on('error', (error) => { if (!ended) { ended = true; controller.error(error); } });
    },
    pull() { socket.resume(); },
    cancel() { ended = true; socket.destroy(); },
  });
  const writable = new WritableStream<Uint8Array>({
    write(data) {
      return new Promise<void>((resolve, reject) => socket.write(data, (error) => error ? reject(error) : resolve()));
    },
    close() { return new Promise<void>((resolve) => socket.end(resolve)); },
    abort() { socket.destroy(); },
  });
  return { readable, writable, close: () => socket.destroy() };
}
export type LocalStream = ReturnType<typeof localStream>;
export async function connectLocal(path: string) {
  const socket = connect(path);
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  return localStream(socket);
}
