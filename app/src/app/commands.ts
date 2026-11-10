import { useEffect, useRef } from 'react';

/**
 * What the Mac's menu bar and its shortcuts ask the app to do (ADR 0032), by the ids its menu
 * items carry (`src-tauri/src/menu.rs`). WVE-203's command registry takes these over.
 */
export type CommandId = 'thread.new' | 'thread.next' | 'thread.previous' | 'composer.focus';

export const COMMANDS: readonly CommandId[] = ['thread.new', 'thread.next', 'thread.previous', 'composer.focus'];

export const isCommand = (id: unknown): id is CommandId => COMMANDS.includes(id as CommandId);

const handlers = new Map<CommandId, Set<() => void>>();

/** Runs `id`'s handlers: whether any did. */
export function runCommand(id: CommandId): boolean {
  const registered = [...(handlers.get(id) ?? [])];
  for (const handler of registered) handler();
  return registered.length > 0;
}

/** Runs `handler` for `id` until the returned function stops it. */
export function onCommand(id: CommandId, handler: () => void): () => void {
  let registered = handlers.get(id);
  if (!registered) {
    registered = new Set();
    handlers.set(id, registered);
  }
  registered.add(handler);
  return () => {
    registered.delete(handler);
  };
}

/** Runs the latest `handler` for `id` while the component is mounted. */
export function useCommand(id: CommandId, handler: () => void) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => onCommand(id, () => latest.current()), [id]);
}
