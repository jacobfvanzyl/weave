import { createCodePlugin } from '@streamdown/code';
import { memo, useMemo, type ComponentProps, type MouseEvent } from 'react';
import {
  defaultComponents,
  defaultRehypePlugins,
  defaultRemarkPlugins,
  type ExtraProps,
  type LinkSafetyModalProps,
  Streamdown,
  type StreamdownProps,
} from 'streamdown';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { imagesAsLinks } from '@/markdown/images-as-links';
import { mathPlugin, withMath } from '@/markdown/math';
import { MermaidSource, mermaidPlugin } from '@/markdown/mermaid';

export type MessageResponseProps = StreamdownProps;

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] };

/** Raw HTML in an agent's Markdown shows as the text it is, never as markup. */
function htmlAsText() {
  const walk = (node: MarkdownNode) => {
    if (node.type === 'html') node.type = 'text';
    node.children?.forEach(walk);
  };
  return walk;
}

const remarkPlugins = [...Object.values(defaultRemarkPlugins), htmlAsText, imagesAsLinks];
// Without `raw`, nothing parses HTML; sanitizing and hardening links stay.
const rehypePlugins = Object.entries(defaultRehypePlugins).filter(([name]) => name !== 'raw').map(([, plugin]) => plugin);

const hostOf = (url: string) => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

/** Asks before opening a link from an agent: its host, then the whole URL. Not opening is the default. */
function LinkConfirmation({ isOpen, onClose, onConfirm, url }: LinkSafetyModalProps) {
  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Open a link to {hostOf(url)}?</AlertDialogTitle>
          <AlertDialogDescription className='break-all font-mono text-xs'>{url}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel autoFocus>Don't open</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Open</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Code in the app's Catppuccin palette; the app is dark, so Mocha is the one shown. */
const plugins: StreamdownProps['plugins'] = {
  code: createCodePlugin({ themes: ['catppuccin-latte', 'catppuccin-mocha'] }),
  math: mathPlugin,
  mermaid: mermaidPlugin,
};

const mermaid: StreamdownProps['mermaid'] = { errorComponent: MermaidSource };

/** Copy and fullscreen, and no downloads, which the iOS web view doesn't save anywhere. */
const controls: StreamdownProps['controls'] = {
  code: { copy: true, download: false },
  mermaid: { copy: true, download: false, fullscreen: true, panZoom: true },
};

const linkSafety: StreamdownProps['linkSafety'] = { enabled: true, renderModal: (props) => <LinkConfirmation {...props} /> };

/** What Streamdown passes a component besides the element's own props: its Markdown node. */
type Rendered<T extends keyof React.JSX.IntrinsicElements> = ComponentProps<T> & ExtraProps;

/** Scrolls to the element a fragment link names, within the same message: footnotes and their way back. */
function scrollToFragment(event: MouseEvent<HTMLAnchorElement>) {
  event.preventDefault();
  const id = decodeURIComponent(event.currentTarget.hash.slice(1));
  const message = event.currentTarget.closest('[data-slot="message-response"]');
  const target = [...(message?.querySelectorAll('[id]') ?? [])].find((element) => element.id === id);
  target?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/**
 * Tables read as part of the text, as the TUI draws them: a bold heading ruled column by column,
 * plain rows, only as wide as they need, and no frame or buttons around them. A column's alignment
 * arrives as the cell's style, which wins over the heading's `text-left`.
 */
const markdownComponents: StreamdownProps['components'] = {
  // A link within the message, such as a footnote's, scrolls to its target; every other link
  // asks before it opens.
  a: ({ node, href, ...props }: Rendered<'a'>) => href?.startsWith('#')
    ? <a href={href} onClick={scrollToFragment} {...props} />
    : <defaultComponents.a node={node} href={href} {...props} />,
  table: ({ node: _node, className, ...props }: Rendered<'table'>) => (
    <div className="my-3 max-w-full overflow-x-auto" data-streamdown="table-wrapper">
      <table
        className={cn('border-separate border-spacing-x-3 border-spacing-y-0 [&_tbody_tr:first-child_td]:pt-1.5', className)}
        data-streamdown="table"
        {...props}
      />
    </div>
  ),
  thead: ({ node: _node, ...props }: Rendered<'thead'>) => <thead data-streamdown="table-header" {...props} />,
  tbody: ({ node: _node, ...props }: Rendered<'tbody'>) => <tbody data-streamdown="table-body" {...props} />,
  tr: ({ node: _node, ...props }: Rendered<'tr'>) => <tr data-streamdown="table-row" {...props} />,
  th: ({ node: _node, className, ...props }: Rendered<'th'>) => (
    <th className={cn('border-b border-muted-foreground/50 pb-1 text-left font-semibold whitespace-nowrap', className)} data-streamdown="table-header-cell" {...props} />
  ),
  td: ({ node: _node, className, ...props }: Rendered<'td'>) => (
    <td className={cn('py-0.5 align-top', className)} data-streamdown="table-cell" {...props} />
  ),
};

/**
 * AI Elements' streaming Markdown response, for agent text, which is untrusted: raw HTML shows as
 * text, links open only once the person confirms them, code is highlighted, math typeset and
 * Mermaid diagrams drawn, all inert.
 */
export const MessageResponse = memo(
  ({ className, children, isAnimating = false, ...props }: MessageResponseProps) => {
    const markdown = useMemo(
      () => (typeof children === 'string' ? withMath(children, { streaming: isAnimating }) : children),
      [children, isAnimating],
    );
    return (
      <Streamdown
        className={cn(
          'min-w-0 max-w-full text-xs/relaxed [overflow-wrap:break-word] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
          className,
        )}
        data-slot="message-response"
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        linkSafety={linkSafety}
        plugins={plugins}
        mermaid={mermaid}
        controls={controls}
        isAnimating={isAnimating}
        {...props}
        components={{ ...markdownComponents, ...props.components }}
      >
        {markdown}
      </Streamdown>
    );
  },
);

MessageResponse.displayName = 'MessageResponse';
