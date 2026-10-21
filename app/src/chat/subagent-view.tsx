import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowRight01Icon } from '@hugeicons/core-free-icons';
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

function Row({ verb, label, detail, subagentId }: { verb: string; label: string; detail?: string; subagentId?: string }) {
  const { root, openSubagent } = useTranscriptContext();
  const canOpen = Boolean(openSubagent && subagentId && root && findSubagent(root, subagentId));
  return (
    <div className='flex min-w-0 flex-col gap-0.5 text-xs' data-slot='subagent-row'>
      <div className='flex min-w-0 items-center gap-1.5'>
        <span aria-hidden='true' className='text-muted-foreground'>•</span>
        <span className='font-semibold'>{verb}</span>
        {canOpen
          ? (
            <Button type='button' size='sm' variant='link' className='h-auto min-w-0 p-0 text-xs font-semibold'
              aria-label={`Show ${label}'s work`} onClick={() => openSubagent?.(subagentId!)}>
              <span className='truncate'>{label}</span>
              <HugeiconsIcon data-icon='inline-end' icon={ArrowRight01Icon} strokeWidth={2} />
            </Button>
          )
          : <span className='truncate font-semibold text-primary'>{label}</span>}
      </div>
      {detail && <p className='line-clamp-3 pl-4 text-muted-foreground whitespace-pre-wrap'>{detail}</p>}
    </div>
  );
}

/** What happened to a subagent, as its parent's transcript says it: `• Spawned Robie`. */
export function SubagentRowView({ entry }: { entry: TranscriptSubagentRow }) {
  const { root } = useTranscriptContext();
  const label = root ? sessionLabel(root, entry.subagentId) : 'A subagent';
  return <Row verb={verbs[entry.event]} label={label} detail={entry.detail} subagentId={entry.subagentId} />;
}

/**
 * A message between this session and another: to or from one of its subagents, as its parent
 * shows them, or to or from its parent, as a subagent's own transcript shows them.
 */
export function SessionMessageView({ entry, transcript }: { entry: TranscriptSessionMessage; transcript: AcpTranscript }) {
  const { root } = useTranscriptContext();
  const own = transcript.sessionId;
  const outgoing = entry.senderSessionId === own || (entry.recipientSessionId != null && entry.recipientSessionId !== own);
  const other = outgoing ? entry.recipientSessionId : entry.senderSessionId;
  const label = sessionLabel(root ?? transcript, other);
  const toSubagent = Boolean(other && findSubagent(transcript, other));
  const verb = toSubagent ? (outgoing ? 'Sent input to' : 'Message from') : (outgoing ? 'To' : 'From');
  return <Row verb={verb} label={label} detail={blocksText(entry.content)} subagentId={toSubagent ? other ?? undefined : undefined} />;
}
