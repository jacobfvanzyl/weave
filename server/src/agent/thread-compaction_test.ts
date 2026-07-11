import type { MastraDBMessage } from "@mastra/core/agent";
import {
  batchCompactionMessages,
  buildCompactionPrompt,
  selectCompactionCut,
  serializeCompactionMessages,
  threadCompactionDisplayMessage,
  validateCompactionSummary,
} from "./thread-compaction.ts";
import type { ThreadCompactionRecord } from "./thread-compaction-repository.ts";

const assert: (condition: unknown, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw new Error(message);
};

const message = (
  id: string,
  role: MastraDBMessage["role"],
  text: string,
  parts?: unknown[],
): MastraDBMessage => ({
  id,
  role,
  createdAt: new Date(`2026-01-01T00:00:${id.padStart(2, "0")}Z`),
  content: { format: 2, parts: (parts ?? [{ type: "text", text }]) as never },
  threadId: "thread-1",
  resourceId: "resource-1",
} as MastraDBMessage);

Deno.test("compaction cuts at a complete user-turn boundary and retains at least two user turns", () => {
  const messages = [
    message("1", "user", "first"),
    message("2", "assistant", "first response"),
    message("3", "user", "second"),
    message("4", "assistant", "second response"),
    message("5", "user", "third"),
    message("6", "assistant", "third response"),
  ];
  const cut = selectCompactionCut(messages, 1);
  assert(cut, "expected a compaction cut");
  assert(
    cut.firstRetained.role === "user",
    "retained history must begin with a user turn",
  );
  assert(
    cut.retained.filter((item) => item.role === "user").length >= 2,
    "expected two retained user turns",
  );
  assert(
    cut.compactedThrough.id === "2",
    "the first turn should be compacted as a unit",
  );
});

Deno.test("compaction serialization redacts secrets and omits reasoning and data-only parts", () => {
  const serialized = serializeCompactionMessages([
    message("1", "user", "", [
      { type: "text", text: "api_key=sk-abcdefghijklmnop" },
      { type: "reasoning", text: "hidden thought" },
      { type: "data-private", data: { secret: true } },
      { type: "file", filename: "diagram.png", mediaType: "image/png" },
    ]),
  ]);
  assert(serialized.includes("[REDACTED]"), "expected credential redaction");
  assert(
    !serialized.includes("hidden thought"),
    "reasoning must not be summarized",
  );
  assert(
    !serialized.includes("data-private"),
    "data-only parts must not be summarized",
  );
  assert(
    serialized.includes("diagram.png"),
    "attachments should be represented by placeholders",
  );
});

Deno.test("cumulative prompts carry the previous checkpoint and summaries require the stable schema", () => {
  const prompt = buildCompactionPrompt({
    previousSummary: "old checkpoint",
    transcript: "new turn",
    instructions: "focus",
  });
  assert(
    prompt.includes("old checkpoint") && prompt.includes("new turn") &&
      prompt.includes("focus"),
    "expected cumulative prompt",
  );
  const summary = [
    "# Objective and user intent",
    "# Decisions and constraints",
    "# Completed outcomes",
    "# Current repository and runtime state",
    "# Remaining work and blockers",
    "# Important identifiers and references",
    "# Failures and work not to repeat",
  ].join("\n\n");
  assert(
    validateCompactionSummary(summary, 1_000).summary === summary,
    "expected valid structured summary",
  );
});

Deno.test("oversized compaction sources are batched without reordering messages", () => {
  const messages = [
    message("1", "user", "A".repeat(80)),
    message("2", "assistant", "B".repeat(80)),
    message("3", "user", "C".repeat(80)),
    message("4", "assistant", "D".repeat(80)),
  ];
  const batches = batchCompactionMessages(messages, 50);
  assert(batches.length > 1, "expected multiple source batches");
  assert(
    batches.flat().map((item) => item.id).join(",") === "1,2,3,4",
    "batching must preserve source order",
  );
});

Deno.test("compaction display markers preserve the automatic/manual trigger", () => {
  const checkpoint = {
    id: "checkpoint-1",
    trigger: "automatic",
    generation: 3,
    completedAt: "2026-01-01T00:00:00.000Z",
  } as ThreadCompactionRecord;
  const marker = threadCompactionDisplayMessage(checkpoint);
  assert(
    marker.parts[0]?.text === "Context automatically compacted",
    "expected automatic display label",
  );
  assert(
    marker.metadata.weaveDisplay.trigger === "automatic",
    "expected persisted trigger metadata",
  );
});
