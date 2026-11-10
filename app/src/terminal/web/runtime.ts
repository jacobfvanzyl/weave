// What every terminal the page draws shares (WVE-205): the WebAssembly module, loaded once, the
// codec its snapshots have, and the terminal's fonts. All of it is built from the Ghostty pin by
// `bun scripts/ghostty.ts web` into `generated/`, which isn't in the repository; a build without
// it has nothing to draw terminals with, and says so.
import { Ghostty } from './core';

const files = import.meta.glob<string>('./generated/*.{wasm,ttf}', { query: '?url', import: 'default', eager: true });
const pins = import.meta.glob<{ commit: string }>('./generated/pin.json', { import: 'default', eager: true });

/** The family the terminal's faces are loaded as, then the Mac's own monospace. */
export const FAMILY = '"Weave Terminal", Menlo, monospace';

const FACES = [
  { file: 'Regular', weight: 'normal', style: 'normal' },
  { file: 'Bold', weight: 'bold', style: 'normal' },
  { file: 'Italic', weight: 'normal', style: 'italic' },
  { file: 'BoldItalic', weight: 'bold', style: 'italic' },
] as const;

export type TerminalRuntime = {
  ghostty: Ghostty;
  /** What this build's snapshots are, as a holder of the same Ghostty names its own (ADR 0022). */
  codec: string;
};

const fonts = async () => {
  await Promise.all(FACES.map(async ({ file, weight, style }) => {
    const url = files[`./generated/JetBrainsMonoNerdFont-${file}.ttf`];
    if (!url || typeof FontFace === 'undefined') return;
    const face = new FontFace('Weave Terminal', `url(${JSON.stringify(url)})`, { weight, style });
    document.fonts.add(await face.load());
  }));
};

const load = async (): Promise<TerminalRuntime> => {
  const module = files['./generated/weave-terminal.wasm'];
  const pin = pins['./generated/pin.json'];
  if (!module || !pin) throw new Error("This build of the app has no terminal to draw with. Build it with `bun scripts/ghostty.ts web`.");
  // A font that doesn't load leaves the Mac's monospace: the terminal still draws.
  const [ghostty] = await Promise.all([Ghostty.load(fetch(module)), fonts().catch(() => undefined)]);
  return { ghostty, codec: ghostty.codec(pin.commit) };
};

let loading: Promise<TerminalRuntime> | undefined;

/** The module and fonts, loaded on the first terminal and kept. A failure is tried again by the next. */
export function terminalRuntime(): Promise<TerminalRuntime> {
  loading ??= load().catch((error) => {
    loading = undefined;
    throw error;
  });
  return loading;
}
