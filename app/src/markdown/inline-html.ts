import rehypeSanitize, { type Options as Schema } from 'rehype-sanitize';
import type { Pluggable } from 'unified';
import { defaultRehypePlugins } from 'streamdown';
import { ALERT_KINDS } from './alerts';

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] };

/** The HTML agents commonly write in Markdown, and the only HTML the app parses. */
const ALLOWED = new Set(['br', 'kbd', 'sup', 'sub', 'ins', 'del', 'details', 'summary']);

/** Tags that open and close, unlike `br`. */
const PAIRED = [...ALLOWED].filter((name) => name !== 'br');

const TAG = /<[^>]*>?/g;
const ALLOWED_TAG = /^<(\/?)([a-z]+)\s*\/?>$/i;

/** The tags in raw HTML, `/details` for a closing one, or `undefined` if any isn't plain and allowed. */
function allowedTags(html: string): string[] | undefined {
  const tags: string[] = [];
  for (const [tag] of html.matchAll(TAG)) {
    const match = ALLOWED_TAG.exec(tag);
    const name = match?.[2].toLowerCase();
    if (!match || !name || !ALLOWED.has(name)) return undefined;
    tags.push(`${match[1]}${name}`);
  }
  return tags;
}

/**
 * Raw HTML in agent text stays HTML only when every tag in it is on the list, without attributes;
 * anything else, comments included, shows as the text it is. A tag whose openings and closings
 * don't balance in the message shows as text too: a `<details>` left open would hide the rest of
 * the message, and a closing tag whose opening had attributes would vanish.
 */
export function inlineHtml() {
  return (tree: MarkdownNode) => {
    const kept: { node: MarkdownNode; tags: string[] }[] = [];
    const walk = (node: MarkdownNode) => {
      if (node.type === 'html') {
        const tags = allowedTags(node.value ?? '');
        if (tags) kept.push({ node, tags });
        else node.type = 'text';
      }
      node.children?.forEach(walk);
    };
    walk(tree);
    for (const name of PAIRED) {
      const count = (prefix: string) => kept.flatMap(({ tags }) => tags).filter((tag) => tag === `${prefix}${name}`).length;
      if (count('') === count('/')) continue;
      for (const { node, tags } of kept) {
        if (tags.includes(name) || tags.includes(`/${name}`)) node.type = 'text';
      }
    }
  };
}

const [, defaultSchema] = defaultRehypePlugins.sanitize as [unknown, Schema];

/** What Markdown itself produces, GFM's tables, task lists, strikethrough and footnotes included. */
const MARKDOWN = [
  'a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'input', 'li', 'ol', 'p',
  'pre', 'section', 'strong', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul',
];

/**
 * Streamdown's sanitizing, cut down to Markdown's own elements and the allowed HTML: no images,
 * pictures, frames or anything else raw HTML could name. Alerts keep their kind.
 */
const sanitizeSchema: Schema = {
  ...defaultSchema,
  tagNames: [...new Set([...MARKDOWN, ...ALLOWED])],
  attributes: {
    ...defaultSchema.attributes,
    blockquote: [...(defaultSchema.attributes?.blockquote ?? []), ['dataAlert', ...ALERT_KINDS]],
  },
};

export const sanitize: Pluggable = [rehypeSanitize, sanitizeSchema];
