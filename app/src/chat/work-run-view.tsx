import { useEffect, useState, type ReactNode } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowRight01Icon, CheckmarkCircle02Icon, Loading03Icon } from '@hugeicons/core-free-icons';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { durationText, type WorkEntry, type WorkRun, workStep, workSummary } from './transcript-runs';

/** The time now, once a second while `ticking`. */
function useNow(ticking: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

/**
 * A run of the agent's work as one row, closed until tapped: "Working" with how long so far and the
 * step it's on while it's the running turn's latest, then "Worked for 2m 17s" with what its tool
 * calls did. A tool call waiting on the person shows below it while it's closed, so its request is
 * never hidden.
 */
export function WorkRunView({ run, renderEntry }: { run: WorkRun; renderEntry(entry: WorkEntry): ReactNode }) {
  const [open, setOpen] = useState(false);
  const failed = run.entries.filter((entry) => entry.kind === 'tool' && entry.status === 'failed').length;
  const waiting = run.entries.filter((entry) => entry.kind === 'tool' && entry.permission?.status === 'pending');
  const now = useNow(run.working && run.since !== undefined);
  const detail = run.working ? workStep(run.entries) : workSummary(run.entries);
  const took = run.since === undefined ? undefined : run.working ? now - run.since : run.until === undefined ? undefined : run.until - run.since;
  const label = run.working ? 'Working' : took === undefined ? 'Worked' : `Worked for ${durationText(took)}`;
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-slot="work-run" data-working={run.working || undefined} className="min-w-0">
      <CollapsibleTrigger
        disabled={run.entries.length === 0}
        className="group/work flex min-h-8 w-full min-w-0 items-center gap-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground disabled:hover:text-muted-foreground"
      >
        {run.working
          ? <HugeiconsIcon icon={Loading03Icon} strokeWidth={2} className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
          : <HugeiconsIcon icon={CheckmarkCircle02Icon} strokeWidth={1.75} className="size-3.5 shrink-0" />}
        <span className={cn('shrink-0 font-medium text-foreground', run.working && 'shimmer')}>{label}</span>
        {run.working && took !== undefined && <span className="shrink-0 tabular-nums">{durationText(took)}</span>}
        {detail && <span className="min-w-0 truncate">{detail}</span>}
        {failed > 0 && <Badge variant="destructive" className="shrink-0">{failed} failed</Badge>}
        {run.entries.length > 0 && (
          <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2}
            className="ml-auto size-3.5 shrink-0 transition-transform group-data-[panel-open]/work:rotate-90 motion-reduce:transition-none" />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 flex flex-col gap-4 border-l pl-3" data-slot="work-run-entries">
        {run.entries.map((entry) => <div key={entry.id} className="min-w-0">{renderEntry(entry)}</div>)}
      </CollapsibleContent>
      {!open && waiting.length > 0 && (
        <div className="mt-2 flex flex-col gap-4" data-slot="work-run-waiting">
          {waiting.map((entry) => <div key={entry.id} className="min-w-0">{renderEntry(entry)}</div>)}
        </div>
      )}
    </Collapsible>
  );
}
