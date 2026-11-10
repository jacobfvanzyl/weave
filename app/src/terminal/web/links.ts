// Addresses in a terminal's text (WVE-205): what a ⌘-click on a cell opens when the program
// didn't mark a link itself (OSC 8). A line that wrapped is read as one, so an address split
// across rows is found whole.
import { CELL, CELL_WORDS, type Frame } from './core';

/** An address as people write them in output: a scheme, then anything but spaces and brackets. */
const ADDRESS = /\b(?:https?:\/\/|mailto:)[^\s<>"'`{}|\\^[\]]+/g;

/** What an address rarely ends with, though a sentence around it does. */
const trailing = (address: string) => {
  let end = address.length;
  for (;;) {
    const last = address[end - 1];
    if (last === undefined) break;
    if ('.,;:!?\'"'.includes(last)) end -= 1;
    // A closing bracket belongs to the address only if it opened one.
    else if (last === ')' && !address.slice(0, end).includes('(')) end -= 1;
    else break;
  }
  return address.slice(0, end);
};

/** Whether the app opens `address`: the web and mail, nothing a program could run. */
export const opens = (address: string) => {
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(address).protocol);
  } catch {
    return false;
  }
};

/** The address written across the cell at (`x`, `y`) on screen, if one is. */
export function addressAt(frame: Frame, x: number, y: number): string | undefined {
  if (x < 0 || y < 0 || x >= frame.columns || y >= frame.rows) return undefined;
  let first = y;
  while (first > 0 && frame.wrapped[first - 1]) first -= 1;
  let last = y;
  while (last < frame.rows - 1 && frame.wrapped[last]) last += 1;
  let line = '';
  let at: number | undefined;
  for (let row = first; row <= last; row += 1) {
    for (let column = 0; column < frame.columns; column += 1) {
      const index = row * frame.columns + column;
      const spacer = ((frame.cells[index * CELL_WORDS + 3] ?? 0) & CELL.spacer) !== 0;
      // A wide character's second cell is the character's.
      if (row === y && column === x) at = spacer ? Math.max(0, line.length - 1) : line.length;
      if (spacer) continue;
      line += frame.text(index) || ' ';
    }
  }
  if (at === undefined) return undefined;
  for (const match of line.matchAll(ADDRESS)) {
    const address = trailing(match[0]);
    if (at >= match.index && at < match.index + address.length) return opens(address) ? address : undefined;
  }
  return undefined;
}
