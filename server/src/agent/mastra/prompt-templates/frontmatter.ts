type ParsedFrontmatter = {
  data: Record<string, unknown>;
  content: string;
};

const parseScalar = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

export const parseFrontmatter = (raw: string): ParsedFrontmatter => {
  if (!raw.startsWith('---\n')) return { data: {}, content: raw };

  const end = raw.indexOf('\n---', 4);
  if (end === -1) return { data: {}, content: raw };

  const frontmatter = raw.slice(4, end).split('\n');
  const contentStart = raw.indexOf('\n', end + 4);
  const content = contentStart === -1 ? '' : raw.slice(contentStart + 1);
  const data: Record<string, unknown> = {};
  let listKey: string | undefined;

  for (const line of frontmatter) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('- ') && listKey) {
      const current = Array.isArray(data[listKey]) ? data[listKey] as string[] : [];
      data[listKey] = [...current, String(parseScalar(trimmed.slice(2)))];
      continue;
    }

    const match = /^(?<key>[A-Za-z0-9_-]+):(?:\s*(?<value>.*))?$/.exec(trimmed);
    if (!match?.groups) continue;

    const key = match.groups.key;
    const value = match.groups.value ?? '';
    listKey = value ? undefined : key;
    data[key] = value ? parseScalar(value) : [];
  }

  return { data, content };
};
