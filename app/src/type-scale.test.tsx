// The type scale (WVE-235): the app's text has the sizes `styles.css` gives its roles and no
// others, and a thread's transcript uses them as the roles say.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createAcpShowcaseTranscript, createFinishedTurnsTranscript, createMarkdownShowcaseTranscript } from '@/chat/acp-showcase';
import { ChatPane, type ChatPaneActions } from '@/chat/chat-pane';
import { MessageResponse } from '@/components/ai-elements/message';
import { TYPE_ROLES, type TypeRole } from '@/lib/type-scale';
import { cn } from '@/lib/utils';

const SOURCE = join(process.cwd(), 'src');

/**
 * Files whose sizes aren't text's: a Bot's avatar sizes its emoji to the avatar, as an icon is.
 * Terminals size their own text (`terminals.ts`), on a canvas, with no class.
 */
const EXEMPT = new Set(['components/bots/bot-avatar.tsx']);

/** Tailwind's sizes, line heights and weights the scale replaces, in a class, with any variant. */
const OFF_SCALE = [
  /(?<![\w-])(?:[\w[\]=-]+:)*text-(?:xs|sm|base|lg|[2-9]?xl)(?:\/[\w.[\]-]+)?(?![\w-])/,
  /(?<![\w-])(?:[\w[\]=-]+:)*text-\[[\d.]+(?:px|rem|em)\]/,
  /(?<![\w-])(?:[\w[\]=-]+:)*leading-(?:none|tight|snug|normal|relaxed|loose|\d+|\[)/,
  /(?<![\w-])(?:[\w[\]=-]+:)*font-(?:thin|extralight|light|bold|extrabold|black)(?![\w-])/,
];

const sources = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  if (entry.isDirectory()) return entry.name === 'generated' || entry.name === 'test' ? [] : sources(path);
  return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
});

/** The role a piece of text takes its size from: the nearest `text-<role>` at or above it. */
const roleOf = (element: Element | null): TypeRole | undefined => {
  for (let at = element; at; at = at.parentElement) {
    const role = TYPE_ROLES.find((name) => at.classList.contains(`text-${name}`));
    if (role) return role;
  }
  return undefined;
};

const actions = (): ChatPaneActions => ({
  send: vi.fn(),
  removeQueued: vi.fn(),
  cancelTurn: vi.fn(),
  respondToPermission: vi.fn(),
  respondToElicitation: vi.fn(),
  setMode: vi.fn(),
  setConfigOption: vi.fn(),
});

/** A transcript on screen with every fold open, as far as opening one shows another. */
const shown = (model: Parameters<typeof ChatPane>[0]['model']) => {
  const view = render(<ChatPane model={model} actions={actions()} />);
  for (let round = 0; round < 6; round++) {
    const closed = [...view.container.querySelectorAll<HTMLElement>('[aria-expanded="false"]')];
    if (closed.length === 0) break;
    closed.forEach((element) => fireEvent.click(element));
  }
  return view.container;
};

const textElements = (root: Element) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const elements = new Set<Element>();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.trim() && node.parentElement) elements.add(node.parentElement);
  }
  return [...elements];
};

const describeElement = (element: Element) =>
  `<${element.tagName.toLowerCase()} ${element.getAttribute('data-slot') ?? element.getAttribute('data-streamdown') ?? ''}> ${element.textContent?.trim().slice(0, 40)}`;

describe('the type scale', () => {
  it("is the only one the stylesheet has: Tailwind's sizes are cleared and each role is defined", () => {
    const css = readFileSync(join(SOURCE, 'styles.css'), 'utf8');
    expect(css).toMatch(/--text-\*:\s*initial;/);
    const defined = [...css.matchAll(/^\s*--text-([\w-]+):/gm)].map(([, name]) => name).filter((name) => !name.includes('--'));
    expect(defined).toEqual([...TYPE_ROLES]);
    // Sizes set in the stylesheet itself: math at the text's size, and nothing else.
    const sizes = [...css.matchAll(/font-size:\s*([^;]+);/g)].map(([, value]) => value.trim());
    expect(sizes).toEqual(['1em', 'max(16px, 1.25vw)']);
  });

  it('sizes nothing in the app off the scale', () => {
    const found = sources(SOURCE).flatMap((path) => {
      const name = relative(SOURCE, path);
      if (EXEMPT.has(name)) return [];
      return readFileSync(path, 'utf8').split('\n').flatMap((line, index) => OFF_SCALE
        .map((pattern) => line.match(pattern)?.[0])
        .filter((match): match is string => Boolean(match))
        .map((match) => `${name}:${index + 1} ${match}`));
    });
    expect(found).toEqual([]);
  });

  it('keeps a role beside a colour when classes are merged, and the later of two roles', () => {
    expect(cn('text-meta', 'text-muted-foreground')).toBe('text-meta text-muted-foreground');
    expect(cn('text-meta text-foreground', 'text-body')).toBe('text-foreground text-body');
  });
});

describe("a thread's transcript", () => {
  const transcripts = {
    showcase: () => createAcpShowcaseTranscript(createFinishedTurnsTranscript('showcase', Date.now() - 20 * 60_000)),
    markdown: createMarkdownShowcaseTranscript,
  };

  it.each(Object.entries(transcripts))('gives every text in the %s transcript a role', (_, transcript) => {
    const root = shown(transcript());
    const unsized = textElements(root).filter((element) => !roleOf(element)).map(describeElement);
    expect(unsized).toEqual([]);
  });

  it('sets what agents and the person say in body, code the same as the prose around it', () => {
    const root = shown(transcripts.markdown());
    const roles = (selector: string) => [...new Set([...root.querySelectorAll(selector)].map(roleOf))];
    expect(roles('[data-slot="message-response"] p')).toEqual(['body']);
    expect(roles('[data-streamdown="inline-code"]')).toEqual(['body']);
    expect(roles('[data-streamdown="code-block-body"]')).toEqual(['body']);
    expect(roles('[data-streamdown="table-cell"], [data-streamdown="list-item"]')).toEqual(['body']);
    expect(roles('[data-slot="bubble-content"]')).toEqual(['body']);
    expect(roles('textarea')).toEqual(['body']);
  });

  it("sets Markdown's headings a step or two above the text, and the rest at its size", () => {
    const { container } = render(<MessageResponse>{'# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six'}</MessageResponse>);
    const headings = [...container.querySelectorAll('h1, h2, h3, h4, h5, h6')];
    expect(headings.map((heading) => `${heading.tagName} ${roleOf(heading)}`)).toEqual([
      'H1 heading-1',
      'H2 heading-2',
      'H3 heading-3',
      'H4 heading-3',
      'H5 heading-3',
      'H6 heading-3',
    ]);
  });

  it('sets tool output in body, and the rows and labels around it in meta', () => {
    const root = shown(transcripts.showcase());
    const roles = (selector: string) => [...new Set([...root.querySelectorAll(selector)].flatMap(textElements).map(roleOf))];
    expect(roles('[data-slot="terminal-output"] pre, [data-slot="tool-content"] pre')).toEqual(['body']);
    expect(roles('[data-slot="tool-header"]')).toEqual(['meta']);
    expect(roles('[data-slot="badge"]')).toEqual(['meta']);
    expect(roles('[data-slot="reasoning-trigger"]')).toEqual(['meta']);
    expect(roles('[data-slot="message-origin"]')).toEqual(['meta']);
  });
});
