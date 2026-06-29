import { AlertTriangle, Check, ChevronDown, Circle, FileText, GitPullRequestArrow, Loader2, MessageSquareWarning } from 'lucide-react';
import { cn } from '../../lib/cn';
import { shouldShowProposalReview } from '../../lib/proposal-review-state';
import {
  useChatStore,
  type PlanStepStatus,
  type ThreadPlan,
  type ThreadProposal,
} from '../../stores/chat-store';
import { useWorkspaceSurfaceStore } from '../../stores/workspace-surface-store';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '../ui/collapsible';

const PlanStatusGlyph = ({ status }: { status: PlanStepStatus }) => {
  if (status === 'completed') {
    return (
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-success/15 text-success">
        <Check size={10} strokeWidth={3} />
      </span>
    );
  }

  if (status === 'in_progress') {
    return <Loader2 size={16} className="mt-0.5 shrink-0 animate-spin text-primary" />;
  }

  if (status === 'blocked') {
    return <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />;
  }

  return <Circle size={16} className="mt-0.5 shrink-0 text-muted-foreground/60" />;
};

const proposalSummary = (proposal: ThreadProposal | undefined) => {
  if (!proposal) return undefined;
  const approved = proposal.counts.approved ?? 0;
  const pending = proposal.counts.pending ?? 0;
  const changesRequested = proposal.counts.changes_requested ?? 0;
  const rejected = proposal.counts.rejected ?? 0;
  const stale = proposal.counts.stale ?? 0;
  const bits = [
    approved > 0 ? `${approved} approved` : undefined,
    pending > 0 ? `${pending} pending` : undefined,
    changesRequested > 0 ? `${changesRequested} changes requested` : undefined,
    rejected > 0 ? `${rejected} rejected` : undefined,
    stale > 0 ? `${stale} stale` : undefined,
  ].filter(Boolean);
  return bits.join(' · ') || `${proposal.items.length} items`;
};

const currentTaskLine = (plan: ThreadPlan | undefined, proposal: ThreadProposal | undefined) => {
  const activeStep = plan?.plan.find(item => item.status === 'in_progress')
    ?? plan?.plan.find(item => item.status === 'blocked')
    ?? plan?.plan.find(item => item.status === 'pending')
    ?? plan?.plan[0];
  if (activeStep?.step) return activeStep.step;
  if (proposal?.summary) return proposal.summary;
  if (proposal) return 'Review proposed changes';
  return undefined;
};

type GuidedTaskCardProps = {
  threadId: string;
};

export const GuidedTaskCard = ({ threadId }: GuidedTaskCardProps) => {
  const plan = useChatStore(state => state.threadPlans[threadId]);
  const proposal = useChatStore(state => state.threadProposals[threadId]);
  const expanded = useChatStore(state => state.guidedTaskExpandedByThread[threadId] ?? false);
  const setExpanded = useChatStore(state => state.setGuidedTaskExpanded);
  const threadWorkspaceId = useChatStore(state => state.threads.find(thread => thread.id === threadId)?.workspaceId);
  const requestEditorFollow = useWorkspaceSurfaceStore(state => state.requestEditorFollow);
  const openProposalReview = useWorkspaceSurfaceStore(state => state.openProposalReview);

  if (!plan && !proposal) return null;

  const isComplete = Boolean(plan && plan.total > 0 && plan.completed >= plan.total);
  const blockedCount = plan?.plan.filter(item => item.status === 'blocked').length ?? 0;
  const taskLine = currentTaskLine(plan, proposal) ?? 'Guided task';
  const summary = proposalSummary(proposal);
  const hasPendingApproval = shouldShowProposalReview(proposal);

  const openPlan = () => {
    if (!plan?.path || !threadWorkspaceId) return;
    requestEditorFollow({
      threadId,
      workspaceId: threadWorkspaceId,
      path: plan.path,
      line: 1,
      toolCallId: 'plan-artifact',
    });
  };

  const openReview = () => {
    if (!proposal?.path) return;
    openProposalReview(proposal.path);
  };

  return (
    <Collapsible
      open={expanded}
      onOpenChange={open => setExpanded(threadId, open)}
      className="mx-auto mb-3 w-full max-w-[var(--weave-chat-content-max-width)] overflow-hidden rounded-lg border border-border bg-card shadow-sm"
      data-weave-guided-task-card
    >
      <div className="flex min-h-11 min-w-0 items-center gap-2 px-3 py-2">
        <CollapsibleTrigger
          className="group flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-label={expanded ? 'Collapse guided task' : 'Expand guided task'}
        >
          <ChevronDown size={15} className={cn('shrink-0 text-muted-foreground transition-transform', !expanded && '-rotate-90')} />
          {plan?.isBusy ? <Loader2 size={14} className="shrink-0 animate-spin text-primary" /> : null}
          {blockedCount > 0 ? <AlertTriangle size={14} className="shrink-0 text-warning" /> : null}
          <span className="min-w-0 truncate text-sm font-medium text-foreground">{taskLine}</span>
        </CollapsibleTrigger>
        {plan ? (
          <Badge size="sm" variant={isComplete ? 'success' : 'info'}>
            {plan.completed}/{plan.total}
          </Badge>
        ) : null}
        {plan?.path ? (
          <Button size="xs" variant="ghost" type="button" onClick={openPlan}>
            <FileText size={14} />
            Plan
          </Button>
        ) : null}
        {hasPendingApproval ? (
          <Button size="xs" variant="ghost" type="button" onClick={openReview}>
            <GitPullRequestArrow size={14} />
            Review
          </Button>
        ) : null}
      </div>
      <CollapsiblePanel>
        <div className="border-t border-border px-3 py-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-foreground">{plan?.title ?? proposal?.title ?? 'Guided task'}</div>
              {summary ? <div className="mt-1 truncate text-xs text-muted-foreground">{summary}</div> : null}
            </div>
          </div>
          {proposal && !proposal.path ? (
            <div className="mt-3 flex items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
              <MessageSquareWarning size={14} className="shrink-0" />
              <span className="min-w-0">Proposal state is present but no artifact path was reported.</span>
            </div>
          ) : null}
          {plan?.plan.length ? (
            <ol className="mt-3 space-y-2">
              {plan.plan.map((item, index) => (
                <li key={`${item.status}-${item.step}-${index}`} className="flex min-w-0 gap-2 text-sm leading-5">
                  <PlanStatusGlyph status={item.status} />
                  <span className={cn(
                    'min-w-0 break-words',
                    item.status === 'completed' && 'text-muted-foreground line-through',
                    item.status === 'in_progress' && 'font-medium text-foreground',
                    item.status === 'blocked' && 'font-medium text-warning-foreground',
                    item.status === 'pending' && 'text-muted-foreground',
                  )}>
                    {item.step}
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
};
