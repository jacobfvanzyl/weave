import { memo } from 'react';
import { defaultRehypePlugins, defaultRemarkPlugins, type LinkSafetyModalProps, Streamdown, type StreamdownProps } from 'streamdown';
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

const remarkPlugins = [...Object.values(defaultRemarkPlugins), htmlAsText];
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

const linkSafety: StreamdownProps['linkSafety'] = { enabled: true, renderModal: (props) => <LinkConfirmation {...props} /> };

/**
 * AI Elements' streaming Markdown response, for agent text, which is untrusted: raw HTML shows as
 * text, and links open only once the person confirms them.
 */
export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn(
        'min-w-0 max-w-full text-xs/relaxed [overflow-wrap:break-word] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        className,
      )}
      data-slot="message-response"
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      linkSafety={linkSafety}
      {...props}
    />
  ),
);

MessageResponse.displayName = 'MessageResponse';
