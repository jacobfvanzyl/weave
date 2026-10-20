import { memo } from 'react';
import { Streamdown, type StreamdownProps } from 'streamdown';
import { cn } from '@/lib/utils';

export type MessageResponseProps = StreamdownProps;

/**
 * AI Elements' streaming Markdown response, narrowed to Alpha's existing
 * Streamdown capabilities. ACP remains the source of message and run state.
 */
export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn(
        'min-w-0 max-w-full text-xs/relaxed [overflow-wrap:break-word] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        className,
      )}
      data-slot="message-response"
      {...props}
    />
  ),
);

MessageResponse.displayName = 'MessageResponse';
