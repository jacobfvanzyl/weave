import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from 'pi-tui';
import { ansi, blendHex, markdownTheme, mocha } from './theme.ts';

export const terminalWidth = () => Deno.consoleSize().columns || 100;

const unwrapMarkdownFences = (text: string) => text.replace(/```(?:md|markdown)\s*\n([\s\S]*?)\n```/gi, '$1');

export const renderMarkdown = (text: string, width = terminalWidth()) => new Markdown(unwrapMarkdownFences(text), 0, 0, markdownTheme)
  .render(Math.max(20, width - 4))
  .map(line => line.trimEnd())
  .join('\n');

export const padVisible = (text: string, width = terminalWidth()) => `${text}${' '.repeat(Math.max(0, width - visibleWidth(text)))}`;

const userMessageBg = (text: string) => ansi.bg(mocha.surface0, text);
const toolBackground = blendHex(mocha.green, mocha.base, 0.15);
const toolMessageBg = (text: string) => ansi.bg(toolBackground, text);

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

export const formatToolSummary = (toolNames: string[], width = terminalWidth()) => {
  const counts = new Map<string, number>();
  for (const name of toolNames) counts.set(name, (counts.get(name) ?? 0) + 1);
  const summary = [...counts.entries()]
    .map(([name, count]) => `${name}${count > 1 ? ` (${count})` : ''}`)
    .join(' | ');
  const text = ` 🔧 ${ansi.fg(mocha.mauve, ansi.bold(summary))}`;
  return [
    toolMessageBg(' '.repeat(width)),
    toolMessageBg(padVisible(truncateToWidth(text, width), width)),
    toolMessageBg(' '.repeat(width)),
  ].join('\n');
};

export const renderPlainText = (text: string, width = terminalWidth()) =>
  text.split('\n').flatMap(line => wrapTextWithAnsi(line, width));
