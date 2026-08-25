import type { ContentBlock } from '@agentclientprotocol/sdk';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  AiAudioIcon,
  AiFile01Icon,
  AiImageIcon,
  Link01Icon,
} from '@hugeicons/core-free-icons';
import { Streamdown } from 'streamdown';
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from '@/components/ui/attachment';

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

export function ContentBlockView({ block }: { block: ContentBlock }) {
  switch (block.type) {
    case 'text':
      return (
        <Streamdown className="min-w-0 text-xs/relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
          {block.text}
        </Streamdown>
      );
    case 'image':
      return (
        <Attachment orientation="vertical" className="w-48">
          <AttachmentMedia variant="image" className="w-full">
            <img
              alt={block.uri || 'Image content'}
              src={`data:${block.mimeType};base64,${block.data}`}
            />
          </AttachmentMedia>
          <AttachmentContent>
            <AttachmentTitle>{block.uri ? fileName(block.uri) : 'Image'}</AttachmentTitle>
            <AttachmentDescription>{block.mimeType}</AttachmentDescription>
          </AttachmentContent>
        </Attachment>
      );
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
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {renderBlocks.map((block, index) => (
        <ContentBlockView key={`${block.type}-${index}`} block={block} />
      ))}
    </div>
  );
}
