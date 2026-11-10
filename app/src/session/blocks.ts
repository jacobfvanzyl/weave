// The Block types the app has (ADR 0031): a reverse-DNS name each, and what its props point at.
// A thread exists apart from its Block: closing the Block hides it, and it can be shown again. A
// terminal is one to one with its Block: closing the Block ends it (WVE-203).
import type { SessionBlock, SessionLayout } from '@/host/protocol';
import { type Target, findBlock, layoutBlocks, newId, placeBlock } from './layout';

export const THREAD_BLOCK = 'weave.thread';
export const TERMINAL_BLOCK = 'weave.terminal';

export const threadBlock = (threadId: string, id = newId()): SessionBlock => ({ id, type: THREAD_BLOCK, props: { threadId } });
export const terminalBlock = (terminalId: string, id = newId()): SessionBlock => ({ id, type: TERMINAL_BLOCK, props: { terminalId } });

const prop = (block: SessionBlock, type: string, name: string) => {
  const value = block.type === type ? block.props?.[name] : undefined;
  return typeof value === 'string' && value ? value : undefined;
};

/** The thread a Block shows, if it shows one. */
export const threadOf = (block: SessionBlock) => prop(block, THREAD_BLOCK, 'threadId');
/** The terminal a Block shows, if it shows one. */
export const terminalOf = (block: SessionBlock) => prop(block, TERMINAL_BLOCK, 'terminalId');

/** The Block that shows the thread `threadId`, if the layout has one. */
export const blockOfThread = (layout: SessionLayout, threadId: string) =>
  layoutBlocks(layout).find((block) => threadOf(block) === threadId);
/** The Block that shows the terminal `terminalId`, if the layout has one. */
export const blockOfTerminal = (layout: SessionLayout, terminalId: string) =>
  layoutBlocks(layout).find((block) => terminalOf(block) === terminalId);

/**
 * The layout with `block` at `target`, or in its first tab when the target has gone, as after
 * another device rearranged it: what the person placed still shows.
 */
export function place(layout: SessionLayout, block: SessionBlock, target?: Target): SessionLayout {
  const placed = target ? placeBlock(layout, block, target) : layout;
  if (findBlock(placed, block.id)) return placed;
  return placeBlock(layout, block, { tab: layout.tabs[0].id });
}

/** The layout showing the thread: in a new Block at `target`, unless a Block already shows it. */
export function showThread(layout: SessionLayout, threadId: string, blockId: string, target?: Target): SessionLayout {
  return blockOfThread(layout, threadId) ? layout : place(layout, threadBlock(threadId, blockId), target);
}

/** The layout showing the terminal: in a new Block at `target`, unless a Block already shows it. */
export function showTerminal(layout: SessionLayout, terminalId: string, blockId: string, target?: Target): SessionLayout {
  return blockOfTerminal(layout, terminalId) ? layout : place(layout, terminalBlock(terminalId, blockId), target);
}
