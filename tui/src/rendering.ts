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

const stringifyToolValue = (value: unknown) => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.stdout === 'string' || typeof record.stderr === 'string') {
      return [record.stdout, record.stderr].filter(item => typeof item === 'string' && item.trim()).join('\n');
    }
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
  }
  return JSON.stringify(value, null, 2);
};

const parseToolObject = (value: unknown) => {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
};

const toolPath = (input: unknown) => {
  const record = parseToolObject(input);
  return typeof record?.path === 'string' ? record.path : undefined;
};

const toolCommand = (input: unknown) => {
  const record = parseToolObject(input);
  return typeof record?.command === 'string' ? record.command : undefined;
};

const toolLineRange = (input: unknown) => {
  if (!input || typeof input !== 'object') return '';
  const { offset, limit } = parseToolObject(input) ?? {};
  if (typeof offset !== 'number') return '';
  return ansi.fg(mocha.yellow, `:${offset}${typeof limit === 'number' ? `-${offset + limit - 1}` : ''}`);
};

const formatToolHeaderLines = (toolName: string | undefined, input: unknown, width: number) => {
  if (toolName === 'bash') {
    const command = toolCommand(input)?.trimEnd();
    if (!command) return [ansi.fg(mocha.mauve, ansi.bold('$ ...'))];
    const [firstLine = '', ...rest] = command.split('\n');
    return [
      ansi.fg(mocha.mauve, ansi.bold(`$ ${firstLine}`)),
      ...rest.flatMap(line => wrapTextWithAnsi(ansi.fg(mocha.text, line), Math.max(1, width - 2))),
    ];
  }
  if (toolName === 'read' || toolName === 'write' || toolName === 'edit') {
    const path = toolPath(input);
    return [`${ansi.fg(mocha.mauve, ansi.bold(toolName))} ${path ? ansi.fg(mocha.blue, path) : ansi.fg(mocha.overlay0, '...')}${toolName === 'read' ? toolLineRange(input) : ''}`];
  }
  return [ansi.fg(mocha.mauve, ansi.bold(toolName ?? 'tool'))];
};

const formatToolOutput = (toolName: string | undefined, output: unknown, width: number) => {
  const text = stringifyToolValue(output).trim();
  if (!text) return [];
  const maxLines = toolName === 'bash' ? 10 : 10;
  const lines = text.split('\n');
  const visibleLines = toolName === 'bash' ? lines.slice(-maxLines) : lines.slice(0, maxLines);
  const skipped = lines.length - visibleLines.length;
  const hint = skipped > 0
    ? [ansi.fg(mocha.overlay0, toolName === 'bash' ? `... (${skipped} earlier lines)` : `... (${skipped} more lines)`)]
    : [];
  return [...hint, ...visibleLines].flatMap(line => wrapTextWithAnsi(ansi.fg(mocha.text, line), Math.max(1, width - 2)));
};

export const formatToolCall = (
  toolName: string | undefined,
  toolCallId: string | undefined,
  width = terminalWidth(),
  input?: unknown,
  output?: unknown,
  isError?: boolean,
) => {
  const headerLines = formatToolHeaderLines(toolName, input ?? (toolCallId ? { path: undefined } : undefined), width).map(line => ` ${line}`);
  const outputLines = formatToolOutput(toolName, output, width);
  const lines = [...headerLines, ...outputLines.map(line => ` ${line}`)];
  const background = isError ? blendHex(mocha.red, mocha.base, 0.15) : toolBackground;
  return [
    ansi.bg(background, ' '.repeat(width)),
    ...lines.map(line => ansi.bg(background, padVisible(truncateToWidth(line, width), width))),
    ansi.bg(background, ' '.repeat(width)),
  ].join('\n');
};

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
