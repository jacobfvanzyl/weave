/** Compact display only; never use this value for filesystem or Host requests. */
export function compactPath(path: string): string {
  const separator = path.includes('\\') ? '\\' : '/';
  const parts = path.split(/[\\/]+/).filter(Boolean);
  // A home marker or drive is a root, not a directory component.
  const directories = parts.filter((part, index) => index !== 0 || (part !== '~' && !/^[a-z]:$/i.test(part)));
  return directories.length > 2 ? `...${separator}${directories.slice(-2).join(separator)}` : path;
}

export function compactTerminalTitle(title: string): string {
  if (title.includes('://')) return title;
  // Shell identity prefixes are chrome metadata, never part of our pane label.
  title = title.replace(/(^|\s)[^\s@:/]+@[^\s:/]+(?=[:\s]|$):?\s*/g, '$1').trim() || 'Terminal';
  return title.replace(/(^|[ :])((?:~?\/|[a-z]:\\)[^\n]*)$/i, (_match, prefix: string, path: string) => `${prefix}${compactPath(path)}`);
}

/** Sidebar directory badges own paths; idle shell titles show the process only. */
export function sidebarTerminalTitle(title: string, processName?: string): string {
  const label = compactTerminalTitle(title);
  if (/(?:^|[ :])(?:~?\/|[a-z]:\\|\.\.\.[\/\\])/i.test(label)) return processName?.split(/[\/\\]/).filter(Boolean).at(-1) || 'Terminal';
  return label;
}
