import type { ThreadCompactionEventData } from "@weave/protocol";

export type ThreadCompactionDisplay = {
  trigger: ThreadCompactionEventData["trigger"];
  generation?: number;
  compactionId?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

export const getThreadCompactionDisplay = (
  metadata: unknown,
): ThreadCompactionDisplay | undefined => {
  if (!isRecord(metadata) || !isRecord(metadata.weaveDisplay)) return undefined;
  const display = metadata.weaveDisplay;
  if (display.kind !== "thread_compaction") return undefined;
  if (display.trigger !== "automatic" && display.trigger !== "manual") {
    return undefined;
  }
  return {
    trigger: display.trigger,
    ...(typeof display.compactionId === "string" ? { compactionId: display.compactionId } : {}),
    ...(typeof display.generation === "number"
      ? { generation: display.generation }
      : {}),
  };
};

export const getThreadCompactionPartDisplay = (
  part: unknown,
): ThreadCompactionDisplay | undefined => {
  if (!isRecord(part)) return undefined;
  const isCompactionPart = part.type === "data-thread-compaction" ||
    (part.type === "data" && part.name === "thread-compaction");
  if (!isCompactionPart || !isRecord(part.data)) return undefined;
  if (part.data.phase !== "completed") return undefined;
  if (part.data.trigger !== "automatic" && part.data.trigger !== "manual") {
    return undefined;
  }
  return {
    trigger: part.data.trigger,
    ...(typeof part.data.compactionId === "string" ? { compactionId: part.data.compactionId } : {}),
    ...(typeof part.data.generation === "number"
      ? { generation: part.data.generation }
      : {}),
  };
};

export const getThreadCompactionDisplayLabel = (
  trigger: ThreadCompactionDisplay["trigger"],
) =>
  trigger === "automatic"
    ? "Context automatically compacted"
    : "Context manually compacted";

export const isThreadCompactionFallbackText = (
  text: unknown,
  followingPart: unknown,
) => {
  if (typeof text !== "string") return false;
  const display = getThreadCompactionPartDisplay(followingPart);
  return display !== undefined &&
    text.trim() === getThreadCompactionDisplayLabel(display.trigger);
};
