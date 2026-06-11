import { isHiddenToolCall, toToolActivityCall } from './tool-activity';

export type AssistantContentRange =
  | { type: 'part'; index: number }
  | { type: 'reasoning'; indices: number[] }
  | { type: 'tool-activity'; indices: number[] };

export const getPartType = (part: unknown) => {
  if (!part || typeof part !== 'object') return '';
  const record = part as Record<string, unknown>;
  return typeof record.type === 'string' ? record.type : '';
};

export const getReasoningText = (part: unknown) => {
  if (!part || typeof part !== 'object') return '';
  const record = part as Record<string, unknown>;
  return record.type === 'reasoning' && typeof record.text === 'string' ? record.text.trim() : '';
};

const isVisibleReasoningPart = (part: unknown) =>
  getPartType(part) === 'reasoning' && getReasoningText(part).length > 0;

const isVisibleToolOutputPart = (part: unknown) => {
  const call = toToolActivityCall(part);
  return call !== null && !isHiddenToolCall(call);
};

export const isVisibleNonReasoningOutputPart = (part: unknown) => {
  const type = getPartType(part);
  if (type === 'reasoning') return false;
  if (type === 'text') {
    const text = part && typeof part === 'object' ? (part as Record<string, unknown>).text : undefined;
    return typeof text === 'string' && text.trim().length > 0;
  }
  if (type === 'tool-call') return isVisibleToolOutputPart(part);
  return false;
};

export const getAssistantContentRanges = (parts: readonly unknown[], showReasoning: boolean): AssistantContentRange[] => {
  const ranges: AssistantContentRange[] = [];
  let reasoningIndices: number[] = [];
  let toolIndices: number[] = [];

  const flushReasoning = () => {
    if (reasoningIndices.length > 0) ranges.push({ type: 'reasoning', indices: reasoningIndices });
    reasoningIndices = [];
  };

  const flushTools = () => {
    if (toolIndices.length > 0) ranges.push({ type: 'tool-activity', indices: toolIndices });
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

    if (type === 'tool-call') {
      if (isVisibleToolOutputPart(part)) {
        flushReasoning();
        toolIndices.push(index);
      }
      continue;
    }

    if (isVisibleNonReasoningOutputPart(part)) {
      flushReasoning();
      flushTools();
      ranges.push({ type: 'part', index });
    }
  }

  flushReasoning();
  flushTools();
  return ranges;
};
