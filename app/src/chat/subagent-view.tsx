import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowRight01Icon, BotIcon } from '@hugeicons/core-free-icons';
import {
  type AcpTranscript,
  blocksText,
  findSubagent,
  type SubagentEvent,
  sessionLabel,
  type TranscriptSessionMessage,
  type TranscriptSubagentRow,
} from './acp-transcript';
import { useTranscriptContext } from './transcript-context';
import { Button } from '@/components/ui/button';

const verbs: Record<SubagentEvent, string> = {
  spawned: 'Spawned',
  resumed: 'Resumed',
  completed: 'Completed',
  interrupted: 'Interrupted',
  stopped: 'Stopped',
  finished: 'Finished',
  unknown: 'Lost track of',
};

/**
 * A subagent's row in its parent's transcript: one line on the fill of a run's card, saying what
 * happened and to which subagent, and opening its work.
 */
function Card({ verb, label, subagentId }: { verb: string; label: string; subagentId: string }) {
  const { root, openSubagent } = useTranscriptContext();
  const canOpen = Boolean(openSubagent && root && findSubagent(root, subagentId));
  return (
    <div
      className='flex min-h-8 min-w-0 items-center gap-2 rounded-md border bg-work-background px-3 py-1.5 text-xs [&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-muted-foreground'
      data-slot='subagent-row'
    >
      <HugeiconsIcon icon={BotIcon} strokeWidth={1.75} />
      <span className='shrink-0 font-medium'>{verb}</span>
      {canOpen
        ? (
          <Button type='button' size='sm' variant='link' className='h-auto min-w-0 shrink p-0 text-xs font-medium'
            aria-label={`Show ${label}'s work`} onClick={() => openSubagent?.(subagentId)}>
            <span className='truncate'>{label}</span>
            <HugeiconsIcon data-icon='inline-end' icon={ArrowRight01Icon} strokeWidth={2} />
          </Button>
        )
        : <span className='truncate font-medium text-primary'>{label}</span>}
    </div>
  );
}

/** A message with this session's parent, as a subagent's own transcript shows it: who, and what it said. */
function Row({ verb, label, detail }: { verb: string; label: string; detail?: string }) {
  return (
    <div className='flex min-w-0 flex-col gap-0.5 text-xs' data-slot='subagent-row'>
      <div className='flex min-w-0 items-center gap-1.5'>
        <span aria-hidden='true' className='text-muted-foreground'>•</span>
        <span className='font-semibold'>{verb}</span>
        <span className='truncate font-semibold text-primary'>{label}</span>
      </div>
      {detail && <p className='line-clamp-3 pl-4 text-muted-foreground whitespace-pre-wrap'>{detail}</p>}
    </div>
  );
}

/** What happened to a subagent, as its parent's transcript says it: `Spawned Robie`, and no more. */
export function SubagentRowView({ entry }: { entry: TranscriptSubagentRow }) {
  const { root } = useTranscriptContext();
  const label = root ? sessionLabel(root, entry.subagentId) : 'A subagent';
  return <Card verb={verbs[entry.event]} label={label} subagentId={entry.subagentId} />;
}

/**
 * A message between this session and another: to or from one of its subagents, as its parent
 * shows them, one line without the message, or to or from its parent, as a subagent's own
 * transcript shows them, with it.
 */
export function SessionMessageView({ entry, transcript }: { entry: TranscriptSessionMessage; transcript: AcpTranscript }) {
  const { root } = useTranscriptContext();
  const own = transcript.sessionId;
  const outgoing = entry.senderSessionId === own || (entry.recipientSessionId != null && entry.recipientSessionId !== own);
  const other = outgoing ? entry.recipientSessionId : entry.senderSessionId;
  const label = sessionLabel(root ?? transcript, other);
  const toSubagent = Boolean(other && findSubagent(transcript, other));
  if (toSubagent && other) return <Card verb={outgoing ? 'Sent input to' : 'Message from'} label={label} subagentId={other} />;
  return <Row verb={outgoing ? 'To' : 'From'} label={label} detail={blocksText(entry.content)} />;
}
