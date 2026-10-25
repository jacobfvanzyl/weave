// Finding math in agent text is adapted from openai/codex `codex-rs/tui/src/markdown_render/math.rs`
// (Apache-2.0, at 970111f6), so the app and the TUI agree on what is math.
import 'katex/dist/katex.min.css';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import type { MathPlugin } from 'streamdown';
import { unified } from 'unified';

/** The longest formula looked for, as in Codex. */
const MAX_MATH_LENGTH = 4096;

type Range = { start: number; end: number };

type Found = Range & {
  /** The TeX between the delimiters. */
  formula: string;
  display: boolean;
  /** What precedes a display's opener on its line: indentation only. */
  indent: string;
};

type MarkdownNode = {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
};

const parser = unified().use(remarkParse).use(remarkGfm);

/** Where math can't be: code, HTML, links, images and link definitions. */
const PROTECTED = new Set(['code', 'inlineCode', 'html', 'link', 'image', 'linkReference', 'imageReference', 'definition']);

function protectedRanges(source: string): Range[] {
  const ranges: Range[] = [];
  const walk = (node: MarkdownNode) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (PROTECTED.has(node.type) && start !== undefined && end !== undefined) {
      ranges.push({ start, end });
      return;
    }
    node.children?.forEach(walk);
  };
  walk(parser.parse(source) as MarkdownNode);
  return ranges.sort((a, b) => a.start - b.start);
}

const escaped = (source: string, offset: number) => {
  let backslashes = 0;
  while (offset - backslashes > 0 && source[offset - backslashes - 1] === '\\') backslashes += 1;
  return backslashes % 2 === 1;
};

const restOfLineHasText = (source: string, from: number) => {
  const newline = source.indexOf('\n', from);
  return source.slice(from, newline === -1 ? undefined : newline).trim() !== '';
};

const ALPHANUMERIC = /[\p{Alphabetic}\p{N}]/u;

/**
 * The math in `source`: `$…$`, `\(…\)`, `$$…$$` and `\[…\]`, found in the source before Markdown
 * parsing, which would take the backslash forms' backslashes for escapes. Never in code, HTML or
 * links. A single `$` is math only when it couldn't be money or a shell variable: not followed by
 * whitespace, `(` or `{`; not closed by whitespace or followed by a letter or digit; not a number
 * without an operator, nor a word in capitals. A display stands on lines of its own. `pending` is
 * where a display still open at the end of the source starts.
 */
export function findMath(source: string): { found: Found[]; pending?: Found; ranges: Range[] } {
  const found: Found[] = [];
  if (!source.includes('$') && !source.includes('\\(') && !source.includes('\\[')) return { found, ranges: [] };
  const ranges = protectedRanges(source);
  let next = 0;
  let offset = 0;
  let scanned = 0;
  let lineStart = 0;
  let lineHasText = false;
  while (offset < source.length) {
    const newline = source.slice(scanned, offset).lastIndexOf('\n');
    if (newline !== -1) {
      lineStart = scanned + newline + 1;
      lineHasText = false;
    }
    lineHasText ||= source.slice(Math.max(scanned, lineStart), offset).trim() !== '';
    scanned = offset;
    while (next < ranges.length && ranges[next].end <= offset) next += 1;
    if (next < ranges.length && ranges[next].start <= offset) {
      offset = ranges[next].end;
      continue;
    }
    const rest = source.slice(offset, offset + 2);
    const [open, close, display] = rest === '$$'
      ? ['$$', '$$', true]
      : rest === '\\['
        ? ['\\[', '\\]', true]
        : rest === '\\('
          ? ['\\(', '\\)', false]
          : rest.startsWith('$')
            ? ['$', '$', false]
            : [undefined, undefined, false];
    if (!open || !close) {
      offset += 1;
      continue;
    }
    const start = offset;
    offset += open.length;
    if (escaped(source, start)) continue;
    const body = source.slice(offset);
    if (open === '$' && /^[\s({]/u.test(body)) continue;
    const rejectedDisplay = display && lineHasText;
    // Only a display on lines of its own may close arbitrarily far away.
    const search = display && !rejectedDisplay ? body : body.slice(0, MAX_MATH_LENGTH);
    let closing = next;
    let multilineClose = false;
    let rejectedClose = false;
    let end: number | undefined;
    for (let index = search.indexOf(close); index !== -1; index = search.indexOf(close, index + 1)) {
      const at = offset + index;
      if (escaped(source, at)) continue;
      if (display) {
        while (closing < ranges.length && ranges[closing].end <= at) closing += 1;
        if (closing < ranges.length && ranges[closing].start < at + close.length) continue;
        if (!rejectedDisplay && restOfLineHasText(source, at + close.length)) {
          if (multilineClose || source.slice(offset, at).includes('\n')) {
            multilineClose = true;
            continue;
          }
          rejectedClose = true;
        }
      }
      end = at;
      break;
    }
    if (rejectedDisplay || rejectedClose) {
      if (end !== undefined && source.slice(offset, end).trim() !== '') {
        // A later line's opening `$$` must stay free for its own equation.
        const lines = source.slice(offset, end).split('\n');
        if (rejectedDisplay && open === '$$' && lines.length > 1 && lines.at(-1)?.trim() === ''
          && restOfLineHasText(source, end + close.length)) {
          continue;
        }
        offset = end + close.length;
      } else if (end === undefined && open === '\\[' && body.length < MAX_MATH_LENGTH) {
        break;
      }
      continue;
    }
    const indent = source.slice(lineStart, start);
    if (end === undefined) {
      if (!display) continue;
      // An open display takes the rest of the source with it.
      const pending = body.length < MAX_MATH_LENGTH
        ? { start, end: source.length, formula: body, display, indent }
        : undefined;
      return { found, pending, ranges };
    }
    const span = { start, end: end + close.length };
    const formula = source.slice(offset, end);
    // Every display owns its closer, even one that isn't math after all, such as one holding its
    // own delimiter, which Codex's renderer leaves as source too.
    if (display) offset = span.end;
    if (display && formula.includes(close)) continue;
    if (next < ranges.length && ranges[next].start < span.end) continue;
    if (!display && formula.includes('\n')) continue;
    if (open === '$') {
      const after = source[span.end];
      if (/\s$/u.test(formula) || (after !== undefined && ALPHANUMERIC.test(after))) continue;
      const money = formula !== '0' && /^[0-9]/.test(formula) && !/[\\^_=+\-*/<>]/.test(formula);
      const shell = formula.length > 1 && /^[A-Z]+$/.test(formula);
      if (money || shell) {
        offset = span.end;
        continue;
      }
    }
    if (formula.length >= MAX_MATH_LENGTH) continue;
    found.push({ ...span, formula, display, indent });
    offset = span.end;
  }
  return { found, ranges };
}

/**
 * `source` with its math in the only forms remark-math is given to parse: `$$…$$` within a line,
 * and `$$` fences around a display. Every other dollar outside code, HTML and links is escaped, so
 * money, shell variables and rejected equations stay the text they are. A display still open at
 * the end becomes an open fence only while the message streams; once it's complete, it is source.
 */
export function withMath(source: string, { streaming = false } = {}): string {
  const { found, pending, ranges } = findMath(source);
  if (!source.includes('$') && found.length === 0 && !pending) return source;
  let output = '';
  let offset = 0;
  const copy = (until: number) => {
    let next = 0;
    for (let index = offset; index < until; index += 1) {
      while (next < ranges.length && ranges[next].end <= index) next += 1;
      const inProtected = next < ranges.length && ranges[next].start <= index;
      const character = source[index];
      output += character === '$' && !inProtected && !escaped(source, index) ? '\\$' : character;
    }
    offset = until;
  };
  for (const math of found) {
    copy(math.start);
    if (math.display) {
      const lead = math.formula.startsWith('\n') ? '' : `\n${math.indent}`;
      const trail = /\n[ \t]*$/.test(math.formula) ? '' : `\n${math.indent}`;
      output += `$$${lead}${math.formula}${trail}$$`;
    } else {
      output += `$$${math.formula}$$`;
    }
    offset = math.end;
  }
  if (pending && streaming) {
    copy(pending.start);
    const lead = pending.formula.startsWith('\n') ? '' : `\n${pending.indent}`;
    return `${output}$$${lead}${pending.formula}`;
  }
  copy(source.length);
  return output;
}

/**
 * KaTeX for the math `withMath` leaves, and for ```` ```math ```` fences: links, images and HTML
 * commands off (`trust`), sizes and macro expansion bounded, and anything it can't typeset shown as
 * its source in the muted colour.
 */
export const mathPlugin: MathPlugin = {
  name: 'katex',
  type: 'math',
  remarkPlugin: [remarkMath, { singleDollarTextMath: false }],
  rehypePlugin: [
    rehypeKatex,
    {
      trust: false,
      maxSize: 10,
      maxExpand: 1000,
      strict: 'ignore',
      errorColor: 'var(--color-muted-foreground)',
    },
  ],
};
