const getBasename = (path: string) => path.split('/').filter(Boolean).pop() ?? path;

export const getNoteFileDisplayName = (path: string) => {
  const basename = getBasename(path);
  return /\.(md|markdown)$/i.test(basename) ? basename.replace(/\.(md|markdown)$/i, '') : basename;
};
