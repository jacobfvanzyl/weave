import { join } from 'node:path';
import { TERMINAL_CODEC } from '../protocol/src/terminal-wire';
/** Native artifacts report the same exact codec identity as their JS package. */
export async function prepareTerminalCodecHeader(directory: string, revision: string) {
  if (TERMINAL_CODEC !== `libghostty-vt:${revision}:weave-1`) throw new Error('Update the terminal codec contract with the Ghostty pin.');
  await Bun.write(join(directory, 'WeaveTerminalCodec.h'), `#pragma once\n#define WEAVE_TERMINAL_CODEC "${TERMINAL_CODEC}"\n`);
}
