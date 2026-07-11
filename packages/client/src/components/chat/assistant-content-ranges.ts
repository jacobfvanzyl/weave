import {
  isHiddenToolCall,
  isLeakedToolOutputText,
  toToolActivityCall,
} from "./tool-activity";
import { parseAskUserPart } from "./ask-user";
import { getThreadCompactionPartDisplay } from "../../lib/thread-compaction-display";

export type AssistantContentRange =
  | { type: "part"; index: number }
  | { type: "reasoning"; indices: number[] }
  | { type: "tool-activity"; indices: number[] };

export type AutoCollapsibleAssistantMessage = {
  id?: string;
  role?: string;
  parts?: readonly unknown[];
  status?: { type?: string };
};

export const getPartType = (part: unknown) => {
  if (!part || typeof part !== "object") return "";
  const record = part as Record<string, unknown>;
  return typeof record.type === "string" ? record.type : "";
};

export const getReasoningText = (part: unknown) => {
  if (!part || typeof part !== "object") return "";
  const record = part as Record<string, unknown>;
  return record.type === "reasoning" && typeof record.text === "string"
    ? record.text.trim()
    : "";
};

export const getTextPartText = (part: unknown) => {
  if (!part || typeof part !== "object") return "";
  const record = part as Record<string, unknown>;
  return record.type === "text" && typeof record.text === "string"
    ? record.text.trim()
    : "";
};

const isVisibleReasoningPart = (part: unknown) =>
  getPartType(part) === "reasoning" && getReasoningText(part).length > 0;

const isVisibleTextPart = (part: unknown) =>
  getPartType(part) === "text" &&
  getTextPartText(part).length > 0 &&
  !isLeakedToolOutputText(getTextPartText(part));

const isVisibleToolOutputPart = (part: unknown) => {
  const call = toToolActivityCall(part);
  return call !== null && !isHiddenToolCall(call);
};

const isSubmittedAskUserPart = (part: unknown) =>
  parseAskUserPart(part)?.status === "submitted";

export const isSteeredUserMessagePart = (part: unknown) => {
  if (!part || typeof part !== "object") return false;
  const record = part as Record<string, unknown>;
  return (
    record.type === "data-user-message" ||
    (record.type === "data" && record.name === "user-message")
  );
};

export const isVisibleNonReasoningOutputPart = (part: unknown) => {
  const type = getPartType(part);
  if (type === "reasoning") return false;
  if (type === "text") return isVisibleTextPart(part);
  if (toToolActivityCall(part)) return isVisibleToolOutputPart(part);
  if (isSubmittedAskUserPart(part)) return true;
  if (isSteeredUserMessagePart(part)) return true;
  if (getThreadCompactionPartDisplay(part)) return true;
  return false;
};

export const getAutoCollapsedAssistantTextPartIndices = (
  _parts: readonly unknown[],
  _showReasoning: boolean,
): number[] => {
  return [];
};

export const getDefaultAutoCollapsedAssistantTurnIds = (
  messages: readonly AutoCollapsibleAssistantMessage[],
  showReasoning: boolean,
  expandedIds: Record<string, true> = {},
) => {
  const ids: Record<string, true> = {};

  for (const message of messages) {
    if (
      message.role !== "assistant" || !message.id ||
      message.status?.type === "running"
    ) continue;
    if (expandedIds[message.id]) continue;
    if (
      getAutoCollapsedAssistantTextPartIndices(
        message.parts ?? [],
        showReasoning,
      ).length === 0
    ) continue;
    ids[message.id] = true;
  }

  return ids;
};

export const getAssistantContentRanges = (
  parts: readonly unknown[],
  showReasoning: boolean,
): AssistantContentRange[] => {
  const ranges: AssistantContentRange[] = [];
  let reasoningIndices: number[] = [];
  let toolIndices: number[] = [];

  const flushReasoning = () => {
    if (reasoningIndices.length > 0) {
      ranges.push({ type: "reasoning", indices: reasoningIndices });
    }
    reasoningIndices = [];
  };

  const flushTools = () => {
    if (toolIndices.length > 0) {
      ranges.push({ type: "tool-activity", indices: toolIndices });
    }
    toolIndices = [];
  };

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const type = getPartType(part);

    if (isVisibleReasoningPart(part)) {
      if (!showReasoning) continue;
      flushTools();
      reasoningIndices.push(index);
      continue;
    }

    if (toToolActivityCall(part)) {
      if (!isVisibleToolOutputPart(part)) continue;
      flushReasoning();
      toolIndices.push(index);
      continue;
    }

    if (isVisibleNonReasoningOutputPart(part)) {
      flushReasoning();
      flushTools();
      ranges.push({ type: "part", index });
    }
  }

  flushReasoning();
  flushTools();
  return ranges;
};
