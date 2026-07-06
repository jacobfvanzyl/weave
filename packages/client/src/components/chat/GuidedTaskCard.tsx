import { AlertTriangle, Check, ChevronDown, Circle, CircleDashed, FileText, GitPullRequestArrow, Loader2, MessageSquareWarning } from 'lucide-react';
import { cn } from '../../lib/cn';
import { canViewProposalReview, getPendingProposalReviewCount } from '../../lib/proposal-review-state';
import {
  useChatStore,
  type PlanStepStatus,
} from '../../stores/chat-store';
import { useWorkspaceSurfaceStore } from '../../stores/workspace-surface-store';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from '../ui/collapsible';
import { guidedTaskDisplay, isPlanComplete } from './guided-task-card-display';

const PlanStatusGlyph = ({ status, isBusy }: { status: PlanStepStatus; isBusy?: boolean }) => {
  if (status === 'completed') {
    return (
      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-success/15 text-success">
        <Check size={10} strokeWidth={3} />
      </span>
    );
  }

  if (status === 'in_progress') {
    return isBusy
      ? <Loader2 size={16} className="mt-0.5 shrink-0 animate-spin text-primary" />
      : <CircleDashed size={16} className="mt-0.5 shrink-0 text-primary" />;
  }

  if (status === 'blocked') {
    return <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />;
  }

  return <Circle size={16} className="mt-0.5 shrink-0 text-muted-foreground/60" />;
};

type GuidedTaskCardProps = {
  threadId: string;
};

export const GuidedTaskCard = ({ threadId }: GuidedTaskCardProps) => {
  const plan = useChatStore(state => state.threadPlans[threadId]);
  const proposal = useChatStore(state => state.threadProposals[threadId]);
  const submittedProposalImplementation = useChatStore(state => state.submittedProposalImplementations[threadId]);
  const expanded = useChatStore(state => state.guidedTaskExpandedByThread[threadId] ?? false);
  const setExpanded = useChatStore(state => state.setGuidedTaskExpanded);
  const threadWorkspaceId = useChatStore(state => state.threads.find(thread => thread.id === threadId)?.workspaceId);
  const requestEditorFollow = useWorkspaceSurfaceStore(state => state.requestEditorFollow);
  const openProposalReview = useWorkspaceSurfaceStore(state => state.openProposalReview);
  const activeSurface = useWorkspaceSurfaceStore(state => state.activeSurface);
  const editorSlotMode = useWorkspaceSurfaceStore(state => state.editorSlotMode);
  const activeProposalPath = useWorkspaceSurfaceStore(state => state.activeProposalPath);

  if (!plan && !proposal) return null;

  const complete = isPlanComplete(plan);
  const blockedCount = plan?.plan.filter(item => item.status === 'blocked').length ?? 0;
  const display = guidedTaskDisplay(plan, proposal, expanded);
  const showBodyHeader = Boolean(display.bodyTitle || display.summary);
  const showProposalPathWarning = Boolean(proposal && !proposal.path);
  const hasSubmittedProposal = Boolean(
    proposal?.path
      && submittedProposalImplementation?.proposalPath === proposal.path
      && (
        !proposal.contentHash
        || !submittedProposalImplementation.proposalContentHash
        || proposal.contentHash === submittedProposalImplementation.proposalContentHash
      ),
  );
  const hasProposalReview = canViewProposalReview(proposal) && !hasSubmittedProposal;
  const pendingApprovalCount = getPendingProposalReviewCount(proposal);
  const isDraftProposal = proposal?.status === 'draft';
  const isProposalReviewOpen = Boolean(
    proposal?.path
      && editorSlotMode === 'proposal_review'
      && activeProposalPath === proposal.path
      && activeSurface.kind === 'thread'
      && activeSurface.threadId === threadId,
  );

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
          <span className="min-w-0 truncate text-sm font-medium text-foreground">{display.titleRow}</span>
        </CollapsibleTrigger>
        {plan ? (
          <Badge size="sm" variant={complete ? 'success' : 'info'}>
            {plan.completed}/{plan.total}
          </Badge>
        ) : null}
        {plan?.path ? (
          <Button size="xs" variant="ghost" type="button" onClick={openPlan}>
            <FileText size={14} />
            Plan
          </Button>
        ) : null}
        {hasProposalReview ? (
          <Button
            size="xs"
            variant="ghost"
            type="button"
            className={isProposalReviewOpen ? 'bg-accent' : undefined}
            aria-pressed={isProposalReviewOpen}
            data-active={isProposalReviewOpen ? 'true' : undefined}
            data-pressed={isProposalReviewOpen ? 'true' : undefined}
            onClick={openReview}
          >
            <GitPullRequestArrow size={14} />
            {isDraftProposal ? 'Draft' : 'Review'}
            {pendingApprovalCount > 0 ? (
              <Badge size="sm" variant={isDraftProposal ? 'outline' : 'info'} className="ml-0.5">
                {pendingApprovalCount}
              </Badge>
            ) : null}
          </Button>
        ) : null}
      </div>
      <CollapsiblePanel>
        <div className="border-t border-border px-3 py-3">
          {showBodyHeader ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <div className="min-w-0 flex-1">
                {display.bodyTitle ? <div className="truncate text-sm font-semibold text-foreground">{display.bodyTitle}</div> : null}
                {display.summary ? <div className={cn('truncate text-xs text-muted-foreground', display.bodyTitle && 'mt-1')}>{display.summary}</div> : null}
              </div>
            </div>
          ) : null}
          {showProposalPathWarning ? (
            <div className="mt-3 flex items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
              <MessageSquareWarning size={14} className="shrink-0" />
              <span className="min-w-0">Proposal state is present but no artifact path was reported.</span>
            </div>
          ) : null}
          {plan?.plan.length ? (
            <ol className={cn('space-y-2', showBodyHeader || showProposalPathWarning ? 'mt-3' : undefined)}>
              {plan.plan.map((item, index) => (
                <li key={`${item.status}-${item.step}-${index}`} className="flex min-w-0 gap-2 text-sm leading-5">
                  <PlanStatusGlyph status={item.status} isBusy={plan.isBusy} />
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
