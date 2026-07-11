import { fuzzyScore } from "./fuzzy";
import type { PromptSummary } from "./prompts-api";

export type SlashCommandMatch = {
  prompt: PromptSummary;
  score: number;
};

export const localSlashCommands: PromptSummary[] = [{
  name: "compact",
  command: "/compact",
  description: "Compact earlier thread context",
  argumentHint: "[focus]",
  tags: ["context", "summary", "compaction"],
  source: "app",
}];
const localSlashCommandNames = new Set(
  localSlashCommands.map((command) => command.name.toLowerCase()),
);

export const mergeSlashCommands = (prompts: PromptSummary[]) => {
  return [
    ...localSlashCommands,
    ...prompts.filter((prompt) =>
      !localSlashCommandNames.has(prompt.name.toLowerCase())
    ),
  ];
};

export const matchSlashCommands = (
  commands: PromptSummary[],
  query: string,
  limit = 8,
): SlashCommandMatch[] =>
  commands
    .map((prompt) => ({
      prompt,
      score: (
        Math.max(
          fuzzyScore(query, prompt.name),
          fuzzyScore(query, prompt.description),
          ...prompt.tags.map((tag) => fuzzyScore(query, tag)),
        )
      ) + (!query && localSlashCommandNames.has(prompt.name.toLowerCase())
        ? 100
        : 0),
    }))
    .filter((match) => match.score > 0)
    .sort((left, right) =>
      right.score - left.score ||
      left.prompt.name.localeCompare(right.prompt.name)
    )
    .slice(0, limit);

export const slashCommandComposerText = (command: PromptSummary) =>
  `/${command.name} `;
