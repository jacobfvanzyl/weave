/** Compact display only; never use this value for filesystem or Host requests. */
export function compactPath(path: string): string {
  const separator = path.includes('\\') ? '\\' : '/';
  const parts = path.split(/[\\/]+/).filter(Boolean);
  // A home marker or drive is a root, not a directory component.
  const directories = parts.filter((part, index) => index !== 0 || (part !== '~' && !/^[a-z]:$/i.test(part)));
  return directories.length > 2 ? `...${separator}${directories.slice(-2).join(separator)}` : path;
}

/** The last component of a directory, for headings; the root stays as it is. */
export function directoryName(path: string): string {
  return path.split(/[\\/]+/).filter(Boolean).at(-1) ?? path;
}
