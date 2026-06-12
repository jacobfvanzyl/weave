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

export const getTextPartText = (part: unknown) => {
  if (!part || typeof part !== 'object') return '';
  const record = part as Record<string, unknown>;
  return record.type === 'text' && typeof record.text === 'string' ? record.text.trim() : '';
};

const isVisibleReasoningPart = (part: unknown) =>
  getPartType(part) === 'reasoning' && getReasoningText(part).length > 0;

const isVisibleTextPart = (part: unknown) =>
  getPartType(part) === 'text' && getTextPartText(part).length > 0;

const isVisibleToolOutputPart = (part: unknown) => {
  const call = toToolActivityCall(part);
  return call !== null && !isHiddenToolCall(call);
};

export const isVisibleNonReasoningOutputPart = (part: unknown) => {
  const type = getPartType(part);
  if (type === 'reasoning') return false;
  if (type === 'text') return isVisibleTextPart(part);
  if (type === 'tool-call') return isVisibleToolOutputPart(part);
  return false;
};

const isVisibleAssistantOutputPart = (part: unknown, showReasoning: boolean) =>
  isVisibleNonReasoningOutputPart(part) || (showReasoning && isVisibleReasoningPart(part));

export const getAutoCollapsedAssistantTextPartIndices = (
  parts: readonly unknown[],
  showReasoning: boolean,
): number[] => {
  let finalTextIndex = -1;

  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (isVisibleTextPart(part)) {
      finalTextIndex = index;
      break;
    }

    if (isVisibleAssistantOutputPart(part, showReasoning)) return [];
  }

  if (finalTextIndex < 0) return [];

  let firstFinalTextIndex = finalTextIndex;
  for (let index = finalTextIndex - 1; index >= 0; index -= 1) {
    if (!isVisibleTextPart(parts[index])) break;
    firstFinalTextIndex = index;
  }

  const hasEarlierWork = parts
    .slice(0, firstFinalTextIndex)
    .some(part => isVisibleAssistantOutputPart(part, showReasoning));
  if (!hasEarlierWork) return [];

  const indices: number[] = [];
  for (let index = firstFinalTextIndex; index <= finalTextIndex; index += 1) {
    if (isVisibleTextPart(parts[index])) indices.push(index);
  }

  return indices;
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
