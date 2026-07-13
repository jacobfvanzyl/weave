import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourceExtensions = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);

const sourceFiles = (relativeRoot: string): string[] => {
  const root = path.join(repoRoot, relativeRoot);
  if (!existsSync(root)) return [];
  const visit = (entry: string): string[] => readdirSync(entry).flatMap(name => {
    const file = path.join(entry, name);
    if (statSync(file).isDirectory()) return visit(file);
    return sourceExtensions.has(path.extname(file)) ? [file] : [];
  });
  return visit(root);
};

const relative = (file: string) => path.relative(repoRoot, file);
const matchingFiles = (files: string[], pattern: RegExp) => files
  .filter(file => pattern.test(readFileSync(file, 'utf8')))
  .map(relative);

describe('single JSON-RPC WebSocket architecture', () => {
  it('keeps renderer shells off server-facing fetch, SSE, and feature WebSockets', () => {
    const files = [
      ...sourceFiles('packages/client/src'),
      ...sourceFiles('desktop/src'),
      ...sourceFiles('web/src'),
      ...sourceFiles('mobile/src'),
    ];
    const serverFetches = matchingFiles(files, /\bfetch\s*\(/)
      .filter(file => file !== 'packages/client/src/lib/coppermind-ink-cell.ts');

    expect(serverFetches).toEqual([]);
    expect(matchingFiles(files, /\bnew\s+WebSocket\s*\(/)).toEqual([]);
    expect(matchingFiles(files, /\bEventSource\b|text\/event-stream/)).toEqual([]);
  });

  it('keeps Portal to one outbound server transport and no local control listener', () => {
    const files = sourceFiles('portal/src');
    expect(matchingFiles(files, /\bDeno\.serve\s*\(/)).toEqual([]);
    expect(matchingFiles(files, /\bnew\s+WebSocket\s*\(/)).toEqual(['portal/src/jupyter.ts']);
    expect(matchingFiles(files, /\bfetch\s*\(/)).toEqual(['portal/src/jupyter.ts']);
  });

  it('exposes only health and the RPC upgrade from the server entrypoint', () => {
    const server = readFileSync(path.join(repoRoot, 'server/src/server.ts'), 'utf8');
    expect([...server.matchAll(/app\.(?:get|post|put|patch|delete)\((['"])(.*?)\1/g)].map(match => match[2]))
      .toEqual(['/health', '/rpc']);
  });

  it('does not retain legacy relay or remote-display capabilities', () => {
    const files = [
      ...sourceFiles('packages/client/src'),
      ...sourceFiles('desktop/src'),
      ...sourceFiles('portal/src'),
      ...sourceFiles('server/src'),
      ...sourceFiles('scripts'),
    ];
    expect(matchingFiles(files, /4112|WEAVE_PORTAL_WS|portal\.(?:window|applications)|clients\/connect|relay-token/))
      .toEqual([]);
    expect(existsSync(path.join(repoRoot, 'portal/native/window-stream-native'))).toBe(false);
    expect(existsSync(path.join(repoRoot, 'portal/window-host-electron'))).toBe(false);
  });
});
