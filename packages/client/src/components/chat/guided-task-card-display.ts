import type { ThreadPlan, ThreadProposal } from '../../stores/chat-store';

export const proposalSummary = (proposal: ThreadProposal | undefined) => {
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
  return bits.length ? bits.join(' · ') : undefined;
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

export const isPlanComplete = (plan: ThreadPlan | undefined) => Boolean(plan && plan.total > 0 && plan.completed >= plan.total);

const guidedTaskName = (plan: ThreadPlan | undefined, proposal: ThreadProposal | undefined) =>
  plan?.title?.trim() || proposal?.title?.trim() || 'Guided task';

export const guidedTaskDisplay = (plan: ThreadPlan | undefined, proposal: ThreadProposal | undefined, expanded: boolean) => {
  const name = guidedTaskName(plan, proposal);
  const inProgressStep = plan?.plan.find(item => item.status === 'in_progress')?.step;
  const titleRow = inProgressStep || (expanded || isPlanComplete(plan) ? name : currentTaskLine(plan, proposal) ?? name);

  return {
    titleRow,
    bodyTitle: titleRow === name ? undefined : name,
    summary: proposalSummary(proposal),
  };
};
