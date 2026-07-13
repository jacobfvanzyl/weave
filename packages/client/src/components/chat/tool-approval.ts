export type ToolApprovalPart = {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

export const parseToolApprovalPart = (part: unknown): ToolApprovalPart | null => {
  if (!isRecord(part) || part.state !== 'approval-requested' || !isRecord(part.approval)) return null;
  const approvalId = typeof part.approval.id === 'string' ? part.approval.id : undefined;
  const toolCallId = typeof part.toolCallId === 'string' ? part.toolCallId : undefined;
  const toolName = typeof part.toolName === 'string'
    ? part.toolName
    : typeof part.type === 'string' && part.type.startsWith('tool-')
    ? part.type.slice('tool-'.length)
    : undefined;
  if (!approvalId || !toolCallId || !toolName) return null;
  return { approvalId, toolCallId, toolName, input: part.input };
};

export const getLatestPendingToolApproval = (
  messages: ReadonlyArray<{ role?: string; parts?: readonly unknown[] }>,
) => {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (message?.role !== 'assistant') continue;
    const parts = message.parts ?? [];
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const approval = parseToolApprovalPart(parts[partIndex]);
      if (approval) return approval;
    }
  }
  return null;
};
