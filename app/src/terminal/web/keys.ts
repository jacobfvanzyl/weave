// A key on the Mac's keyboard as the terminal takes it (WVE-205). ⌘ is the app's and its menu
// bar's, so a key with it isn't the terminal's. Option types the layout's characters (∫, å, an
// accent to compose), as Ghostty does unless told otherwise, and with a key that types nothing,
// an arrow say, it's the Alt a shell's word motions expect. Everything else goes to the encoder
// with the key's place on the keyboard and what it types.
import { MODS, type Key } from './core';

export type Pressed = Pick<KeyboardEvent, 'key' | 'code' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'repeat' | 'isComposing'>;

/**
 * What to do with a key going down or up: encode it; leave it to the text field, which composes
 * accents and input methods into text that arrives by itself (`compose`); or leave it alone,
 * as the app's own.
 */
export function keyFor(event: Pressed, action: 'press' | 'release'): Key | 'compose' | undefined {
  if (event.metaKey) return undefined;
  if (event.isComposing || event.key === 'Dead' || event.key === 'Process') return 'compose';
  const mods = (event.shiftKey ? MODS.shift : 0) | (event.ctrlKey ? MODS.control : 0) | (event.altKey ? MODS.option : 0);
  const types = [...event.key].length === 1;
  const how = action === 'release' ? 'release' : event.repeat ? 'repeat' : 'press';
  // A software keyboard's keys have no place on one: a key that types nothing goes by its name,
  // which is its place's too (`Backspace`, `Enter`, `Tab`, an arrow).
  if (!types) return { code: event.code && event.code !== 'Unidentified' ? event.code : event.key, mods, action: how };
  // Option made the character, so it isn't held over it too.
  if (event.altKey && !event.ctrlKey) return { code: event.code, text: event.key, mods: mods & ~MODS.option, action: how };
  return { code: event.code, text: event.key, mods, action: how };
}
