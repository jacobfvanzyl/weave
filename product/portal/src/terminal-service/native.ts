import { TERMINAL_CODEC } from './contract';
import { createRequire } from 'node:module';
import { join } from 'node:path';
export type TerminalVt = {
  codec: string;
  create(cols: number, rows: number): number;
  write(id: number, data: Buffer): Buffer;
  resize(id: number, cols: number, rows: number): Buffer;
  snapshot(id: number): { data: Buffer; offsets: number[] };
  processDirectory(pid: number): string;
  metadata(id: number): { title: string; directory: string };
  close(id: number): void;
};
export function loadTerminalVt(path = process.env.WEAVE_TERMINAL_NATIVE ?? join(import.meta.dir, '../../dist/terminal-vt.node')): TerminalVt {
  const native = createRequire(import.meta.url)(path) as TerminalVt;
  if (native.codec !== TERMINAL_CODEC) throw new Error('Terminal native codec mismatch; install matching service components');
  return native;
}
