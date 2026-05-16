import type { ChatMessage, RenderMessage } from './types.ts';
import { formatToolCall, formatToolSummary, isRenameThreadTool, renderMarkdown, renderPlainText, renderUserMessage } from './rendering.ts';
import { ansi, mocha } from './theme.ts';

export const toolNameFromPartType = (type: string) => type.startsWith('tool-') ? type.slice('tool-'.length) : undefined;

const toolPayloadTitle = (value: unknown) =>
  value && typeof value === 'object' && typeof (value as { title?: unknown }).title === 'string'
    ? (value as { title: string }).title.trim()
    : '';

export const renameTitleFromMessages = (messages: ChatMessage[]) => {
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (typeof part.type !== 'string' || !part.type.startsWith('tool-')) continue;
      const toolName = toolNameFromPartType(part.type);
      if (!isRenameThreadTool(toolName)) continue;
      const title = toolPayloadTitle(part.output) || toolPayloadTitle(part.input);
      if (title) return title;
    }
  }
  return '';
};

export const renderMessagePart = (part: Record<string, unknown>) => {
  if (part.type === 'text' && typeof part.text === 'string') return part.text;
  if (part.type === 'reasoning' && typeof part.text === 'string') return part.text;

  if (typeof part.type === 'string' && part.type.startsWith('tool-')) {
    const toolName = toolNameFromPartType(part.type);
    if (isRenameThreadTool(toolName)) return '';
    return formatToolCall(toolName, typeof part.toolCallId === 'string' ? part.toolCallId : undefined);
  }

  return '';
};

export const textFromMessage = (message: ChatMessage) => (message.parts ?? [])
  .map(renderMessagePart)
  .filter(Boolean)
  .join('\n');

export const chatMessageToRenderMessages = (message: ChatMessage): RenderMessage[] => {
  if (message.role === 'system') {
    const text = textFromMessage(message).trim();
    return text ? [{ type: 'system', text }] : [];
  }
  if (message.role === 'user') {
    const text = textFromMessage(message).trim();
    return text ? [{ type: 'user', id: message.id, text }] : [];
  }

  const rendered: RenderMessage[] = [];
  const textParts: string[] = [];
  for (const part of message.parts ?? []) {
    if (part.type === 'text' && typeof part.text === 'string') textParts.push(part.text);
    if (part.type === 'reasoning' && typeof part.text === 'string') textParts.push(part.text);
    if (typeof part.type === 'string' && part.type.startsWith('tool-')) {
      const toolName = toolNameFromPartType(part.type);
      if (isRenameThreadTool(toolName)) continue;
      rendered.push({
        type: 'tool',
        toolName: toolName ?? 'tool',
        toolCallId: typeof part.toolCallId === 'string' ? part.toolCallId : undefined,
        input: part.input,
        output: part.output,
        isError: part.state === 'output-error',
      });
    }
  }
  const text = textParts.join('\n').trim();
  if (text) rendered.push({ type: 'assistant', id: message.id, rawText: text, renderedText: renderMarkdown(text) });
  return rendered;
};

export const renderToolSummary = (messages: RenderMessage[], width: number) =>
  formatToolSummary(messages.filter(message => message.type === 'tool').map(message => message.toolName), width).split('\n');

const workingSpinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const renderWorkingSpinner = (frame = 0) => {
  const spinner = workingSpinnerFrames[frame % workingSpinnerFrames.length] ?? workingSpinnerFrames[0];
  return `${ansi.fg(mocha.blue, spinner)} ${ansi.fg(mocha.overlay0, 'Working...')}`;
};

export const renderTranscriptMessage = (message: RenderMessage, width: number) => {
  if (message.type === 'user') return renderUserMessage(message.text, width).split('\n');
  if (message.type === 'assistant') {
    if (message.pending && !message.rawText.trim()) return [renderWorkingSpinner(message.spinnerFrame)];
    return message.renderedText ? message.renderedText.split('\n') : renderPlainText(message.rawText, width);
  }
  if (message.type === 'tool') return formatToolCall(message.toolName, message.toolCallId, width, message.input, message.output, message.isError).split('\n');
  return [ansi.fg(mocha.overlay0, message.text)];
};

export const getMessagesVersion = (messages: ChatMessage[]) => messages
  .map(message => `${message.id}:${message.role}:${message.parts?.length ?? 0}:${textFromMessage(message).length}`)
  .join('|');
