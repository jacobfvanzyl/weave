import type { ThreadPlan, ThreadProposal } from '../../stores/chat-store';

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
  const titleRow = expanded || isPlanComplete(plan) ? name : currentTaskLine(plan, proposal) ?? name;

  return {
    titleRow,
    bodyTitle: titleRow === name ? undefined : name,
    summary: undefined,
  };
};
