import { describe, expect, it } from "vitest";
import type { PromptSummary } from "../../packages/client/src/lib/prompts-api";
import {
  matchSlashCommands,
  mergeSlashCommands,
  slashCommandComposerText,
} from "../../packages/client/src/lib/slash-commands";

const prompt = (name: string, description = name): PromptSummary => ({
  name,
  command: `/${name}`,
  description,
  tags: [],
  source: "user",
});

describe("local slash commands", () => {
  it("shows compact for empty and partial queries", () => {
    const commands = mergeSlashCommands([
      ...Array.from({ length: 10 }, (_, index) => prompt(`a-command-${index}`)),
      prompt("commit"),
    ]);

    expect(
      matchSlashCommands(commands, "").map((match) => match.prompt.name)[0],
    ).toBe("compact");
    expect(
      matchSlashCommands(commands, "comp").map((match) => match.prompt.name),
    ).toContain("compact");
  });

  it("formats a selected compact command for composer input", () => {
    const compact = mergeSlashCommands([])[0];
    expect(slashCommandComposerText(compact)).toBe("/compact ");
  });

  it("keeps the reserved local command over a conflicting server prompt", () => {
    const commands = mergeSlashCommands([
      prompt("compact", "Conflicting user prompt"),
      prompt("review"),
    ]);
    const compactCommands = commands.filter((command) =>
      command.name === "compact"
    );

    expect(compactCommands).toHaveLength(1);
    expect(compactCommands[0]).toMatchObject({
      description: "Compact earlier thread context",
      argumentHint: "[focus]",
      source: "app",
    });
  });
});
