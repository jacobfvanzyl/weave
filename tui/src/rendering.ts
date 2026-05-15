import { Markdown, truncateToWidth, wrapTextWithAnsi } from 'pi-tui';
import { ansi, markdownTheme, mocha } from './theme.ts';

export const terminalWidth = () => Deno.consoleSize().columns || 100;

export const renderMarkdown = (text: string, width = terminalWidth()) => new Markdown(text, 0, 0, markdownTheme)
  .render(Math.max(20, width - 4))
  .map(line => line.trimEnd())
  .join('\n');

export const padVisible = (text: string, width = terminalWidth()) => `${text}${' '.repeat(Math.max(0, width - text.length))}`;

const userMessageBg = (text: string) => ansi.bg(mocha.surface0, text);

export const renderUserMessage = (text: string, width = terminalWidth()) => {
  const lines = text.split('\n').flatMap(line => wrapTextWithAnsi(line, Math.max(1, width - 1)));
  return [
    userMessageBg(' '.repeat(width)),
    ...lines.map(line => userMessageBg(padVisible(` ${line}`, width))),
    userMessageBg(' '.repeat(width)),
  ].join('\n');
};

export const isRenameThreadTool = (toolName: string | undefined) => toolName === 'renameThreadTool' || toolName === 'rename-thread';

export const formatToolCall = (toolName: string | undefined, toolCallId: string | undefined, width = terminalWidth()) =>
  truncateToWidth(`🔧 ${ansi.fg(mocha.mauve, ansi.bold(toolName ?? toolCallId ?? 'tool'))}`, width);

export const renderPlainText = (text: string, width = terminalWidth()) =>
  text.split('\n').flatMap(line => wrapTextWithAnsi(line, width));
