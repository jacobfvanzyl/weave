const tokenizeArgs = (input: string) => {
  const args: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  for (const match of input.matchAll(pattern)) {
    args.push((match[1] ?? match[2] ?? match[3] ?? '').replace(/\\(["'])/g, '$1'));
  }
  return args;
};

export const expandArguments = (content: string, argsText: string) => {
  const args = tokenizeArgs(argsText.trim());
  const allArgs = args.join(' ');

  return content
    .replace(/\$ARGUMENTS/g, argsText.trim())
    .replace(/\$@/g, allArgs)
    .replace(/\$\{@:([0-9]+)(?::([0-9]+))?\}/g, (_match, startValue: string, lengthValue?: string) => {
      const start = Math.max(Number(startValue) - 1, 0);
      const length = lengthValue ? Number(lengthValue) : undefined;
      return args.slice(start, length === undefined ? undefined : start + length).join(' ');
    })
    .replace(/\$([1-9][0-9]*)/g, (_match, indexValue: string) => args[Number(indexValue) - 1] ?? '');
};
