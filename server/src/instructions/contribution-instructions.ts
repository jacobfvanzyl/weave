import { readFileSync } from 'node:fs';

const cache = new Map<string, string>();

export const contributionDescription = (id: string) => {
  const cached = cache.get(id);
  if (cached) return cached;
  const content = readFileSync(new URL(`./contributions/${id}/INSTRUCTION.md`, import.meta.url), 'utf8').trim();
  if (!content) throw new Error(`Contribution instruction is empty: ${id}`);
  cache.set(id, content);
  return content;
};
