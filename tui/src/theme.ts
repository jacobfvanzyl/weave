import type { MarkdownTheme } from 'pi-tui';
import { highlightCode } from './highlight.ts';

export const mocha = {
  rosewater: '#f5e0dc', flamingo: '#f2cdcd', pink: '#f5c2e7', mauve: '#cba6f7',
  red: '#f38ba8', maroon: '#eba0ac', peach: '#fab387', yellow: '#f9e2af',
  green: '#a6e3a1', teal: '#94e2d5', sky: '#89dceb', sapphire: '#74c7ec',
  blue: '#89b4fa', lavender: '#b4befe', text: '#cdd6f4', subtext1: '#bac2de',
  subtext0: '#a6adc8', overlay2: '#9399b2', overlay1: '#7f849c', overlay0: '#6c7086',
  surface2: '#585b70', surface1: '#45475a', surface0: '#313244', base: '#1e1e2e',
  mantle: '#181825', crust: '#11111b',
};

const hexToRgb = (hex: string) => {
  const value = hex.replace('#', '');
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
};

const rgbToHex = ({ r, g, b }: { r: number; g: number; b: number }) =>
  `#${[r, g, b].map(value => Math.round(value).toString(16).padStart(2, '0')).join('')}`;

export const blendHex = (foreground: string, background: string, alpha: number) => {
  const fg = hexToRgb(foreground);
  const bg = hexToRgb(background);
  return rgbToHex({
    r: fg.r * alpha + bg.r * (1 - alpha),
    g: fg.g * alpha + bg.g * (1 - alpha),
    b: fg.b * alpha + bg.b * (1 - alpha),
  });
};

export const ansi = {
  reset: '\x1b[0m',
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
  underline: (text: string) => `\x1b[4m${text}\x1b[24m`,
  strikethrough: (text: string) => `\x1b[9m${text}\x1b[29m`,
  fg: (hex: string, text: string) => {
    const { r, g, b } = hexToRgb(hex);
    return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
  },
  bg: (hex: string, text: string) => {
    const { r, g, b } = hexToRgb(hex);
    return `\x1b[48;2;${r};${g};${b}m${text}\x1b[49m`;
  },
};

export const markdownTheme: MarkdownTheme = {
  heading: text => ansi.fg(mocha.peach, text),
  link: text => ansi.fg(mocha.blue, text),
  linkUrl: text => ansi.fg(mocha.overlay0, text),
  code: text => ansi.fg(mocha.teal, text),
  codeBlock: text => text,
  codeBlockBorder: text => ansi.fg(mocha.surface0, text),
  quote: text => ansi.fg(mocha.overlay0, text),
  quoteBorder: text => ansi.fg(mocha.surface0, text),
  hr: text => ansi.fg(mocha.surface0, text),
  listBullet: text => ansi.fg(mocha.mauve, text),
  bold: ansi.bold,
  italic: ansi.italic,
  underline: ansi.underline,
  strikethrough: ansi.strikethrough,
  highlightCode,
};
