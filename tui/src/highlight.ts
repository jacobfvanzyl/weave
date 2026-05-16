import { highlight, supportsLanguage } from 'cli-highlight';
import { ansi, mocha } from './theme.ts';

const languageAliases: Record<string, string> = {
  md: 'markdown',
  markdown: 'markdown',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  yml: 'yaml',
};

const highlightTheme = {
  keyword: (text: string) => ansi.fg(mocha.mauve, text),
  built_in: (text: string) => ansi.fg(mocha.yellow, text),
  literal: (text: string) => ansi.fg(mocha.peach, text),
  number: (text: string) => ansi.fg(mocha.peach, text),
  string: (text: string) => ansi.fg(mocha.green, text),
  comment: (text: string) => ansi.fg(mocha.overlay0, text),
  function: (text: string) => ansi.fg(mocha.blue, text),
  title: (text: string) => ansi.fg(mocha.blue, text),
  class: (text: string) => ansi.fg(mocha.yellow, text),
  type: (text: string) => ansi.fg(mocha.yellow, text),
  attr: (text: string) => ansi.fg(mocha.teal, text),
  variable: (text: string) => ansi.fg(mocha.lavender, text),
  params: (text: string) => ansi.fg(mocha.lavender, text),
  operator: (text: string) => ansi.fg(mocha.sky, text),
  punctuation: (text: string) => ansi.fg(mocha.overlay2, text),
};

const normalizeLanguage = (lang?: string) => {
  if (!lang) return undefined;
  const normalized = languageAliases[lang.toLowerCase()] ?? lang.toLowerCase();
  return supportsLanguage(normalized) ? normalized : undefined;
};

export const highlightCode = (code: string, lang?: string) => {
  const language = normalizeLanguage(lang);
  if (!language) return code.split('\n').map(line => ansi.fg(mocha.text, line));

  try {
    return highlight(code, { language, ignoreIllegals: true, theme: highlightTheme }).split('\n');
  } catch {
    return code.split('\n').map(line => ansi.fg(mocha.text, line));
  }
};
