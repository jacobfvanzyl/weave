import { useState } from 'react';
import type { ContentBlock } from '@/host/protocol';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  AiAudioIcon,
  AiFile01Icon,
  AiImageIcon,
  Link01Icon,
} from '@hugeicons/core-free-icons';
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from '@/components/ui/attachment';
import { MessageResponse } from '@/components/ai-elements/message';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

const fileName = (uri: string) => {
  const tail = uri.split('/').filter(Boolean).at(-1);
  return tail || uri;
};

export const coalesceContentBlocks = (blocks: ContentBlock[]): ContentBlock[] => {
  const result: ContentBlock[] = [];
  for (const block of blocks) {
    const previous = result.at(-1);
    if (previous?.type === 'text' && block.type === 'text') {
      result[result.length - 1] = {
        ...previous,
        text: previous.text + block.text,
      };
    } else {
      result.push(block);
    }
  }
  return result;
};

function ResourceAttachment({ block }: { block: Extract<ContentBlock, { type: 'resource_link' }> }) {
  return (
    <Attachment size="sm">
      <AttachmentMedia>
        <HugeiconsIcon icon={Link01Icon} strokeWidth={1.75} />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>
          <a
            className="underline-offset-4 hover:underline"
            href={block.uri}
            rel="noreferrer"
            target="_blank"
          >
            {block.title || block.name}
          </a>
        </AttachmentTitle>
        <AttachmentDescription>
          {block.description || block.mimeType || block.uri}
        </AttachmentDescription>
      </AttachmentContent>
    </Attachment>
  );
}

function EmbeddedResourceView({ block }: { block: Extract<ContentBlock, { type: 'resource' }> }) {
  const resource = block.resource;
  if ('text' in resource) {
    return (
      <div className="overflow-hidden rounded-md border bg-card">
        <div className="flex items-center gap-2 border-b px-2 py-1 text-[0.625rem] text-muted-foreground">
          <HugeiconsIcon icon={AiFile01Icon} strokeWidth={1.75} className="size-3" />
          <span className="truncate">{fileName(resource.uri)}</span>
          {resource.mimeType && <span className="ml-auto">{resource.mimeType}</span>}
        </div>
        <pre className="overflow-x-auto p-2 text-xs/relaxed whitespace-pre-wrap">
          {resource.text}
        </pre>
      </div>
    );
  }

  return (
    <Attachment size="sm">
      <AttachmentMedia>
        <HugeiconsIcon icon={AiFile01Icon} strokeWidth={1.75} />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{fileName(resource.uri)}</AttachmentTitle>
        <AttachmentDescription>
          {resource.mimeType || 'Binary resource'} · {resource.blob.length} encoded bytes
        </AttachmentDescription>
      </AttachmentContent>
    </Attachment>
  );
}

/** An image in a prompt or message, as a thumbnail that opens it whole. */
function ImageThumbnail({ block }: { block: Extract<ContentBlock, { type: 'image' }> }) {
  const [open, setOpen] = useState(false);
  const src = `data:${block.mimeType};base64,${block.data}`;
  const name = block.uri ? fileName(block.uri) : 'Image';
  return (
    <>
      <button
        type="button"
        aria-label={`Show ${name}`}
        className="size-20 shrink-0 overflow-hidden rounded-md border bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
        onClick={() => setOpen(true)}
      >
        <img alt="" src={src} className="size-full object-cover" loading="lazy" decoding="async" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[min(48rem,calc(100%-2rem))] max-w-none p-2 sm:max-w-none">
          <DialogTitle className="sr-only">{name}</DialogTitle>
          <img alt={name} src={src} className="max-h-[80vh] w-full rounded-md object-contain" />
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ContentBlockView({ block }: { block: ContentBlock }) {
  switch (block.type) {
    case 'text':
      return (
        <MessageResponse>
          {block.text}
        </MessageResponse>
      );
    case 'image':
      return <ImageThumbnail block={block} />;
    case 'audio':
      return (
        <Attachment size="sm" className="w-full max-w-sm">
          <AttachmentMedia>
            <HugeiconsIcon icon={AiAudioIcon} strokeWidth={1.75} />
          </AttachmentMedia>
          <AttachmentContent>
            <AttachmentTitle>Audio</AttachmentTitle>
            <audio
              aria-label="Audio content"
              className="mt-1 h-7 w-full"
              controls
              src={`data:${block.mimeType};base64,${block.data}`}
            />
          </AttachmentContent>
        </Attachment>
      );
    case 'resource_link':
      return <ResourceAttachment block={block} />;
    case 'resource':
      return <EmbeddedResourceView block={block} />;
  }
}

export function ContentBlocksView({ blocks }: { blocks: ContentBlock[] }) {
  const renderBlocks = coalesceContentBlocks(blocks);
  const images = renderBlocks.filter((block) => block.type === 'image');
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {renderBlocks.map((block, index) => block.type === 'image'
        ? null
        : <ContentBlockView key={`${block.type}-${index}`} block={block} />)}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-1.5" data-slot="image-thumbnails">
          {images.map((block, index) => <ContentBlockView key={`image-${index}`} block={block} />)}
        </div>
      )}
    </div>
  );
}
