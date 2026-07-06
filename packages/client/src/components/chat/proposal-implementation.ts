import type { UIMessage } from 'ai';
import type { ProposalImplementationRequest } from '../../stores/chat-store';

export type ProposalActionDisplayKind = 'proposal_review_feedback' | 'proposal_implementation_request';

export type ProposalActionDisplay = {
  kind: ProposalActionDisplayKind;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const proposalActionKindForMode = (mode: unknown): ProposalActionDisplayKind =>
  mode === 'address_feedback' ? 'proposal_review_feedback' : 'proposal_implementation_request';

const getProposalActionDisplayFromRecord = (metadata: Record<string, unknown>): ProposalActionDisplay | null => {
  const display = metadata.weaveDisplay;
  if (isRecord(display)) {
    const kind = display.kind;
    if (kind === 'proposal_review_feedback' || kind === 'proposal_implementation_request') {
      return { kind };
    }
  }

  const proposalImplementation = metadata.proposalImplementation;
  if (!isRecord(proposalImplementation)) return null;

  return { kind: proposalActionKindForMode(proposalImplementation.mode) };
};

const getProposalActionDisplayFromText = (text: string): ProposalActionDisplay | null => {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('Address review feedback for the proposal at ')) {
    return { kind: 'proposal_review_feedback' };
  }
  if (trimmed.startsWith('Implement the approved proposal items from ')) {
    return { kind: 'proposal_implementation_request' };
  }
  return null;
};

export const getProposalActionDisplay = (metadata: unknown, text?: string): ProposalActionDisplay | null => {
  if (isRecord(metadata)) {
    const direct = getProposalActionDisplayFromRecord(metadata);
    if (direct) return direct;

    if (isRecord(metadata.custom)) {
      const nested = getProposalActionDisplayFromRecord(metadata.custom);
      if (nested) return nested;
    }
  }

  return typeof text === 'string' ? getProposalActionDisplayFromText(text) : null;
};

export const getProposalActionDisplayLabel = (display: ProposalActionDisplay) =>
  display.kind === 'proposal_review_feedback' ? 'Revise proposal' : 'Implement proposal';

export const buildProposalImplementationMessage = (
  request: Pick<ProposalImplementationRequest, 'proposalPath' | 'approvedItemIds' | 'mode'>,
) => {
  if (request.mode === 'address_feedback') {
    return [
      `Address review feedback for the proposal at ${request.proposalPath}.`,
      '',
      'Before editing anything, read the proposal artifact and its review comments.',
      'Do not modify source files yet. Use proposal_read plus proposal_write/proposal_edit/proposal_delete to revise the proposed file buffers so they address the feedback.',
      'Re-evaluate the entire proposal in light of the requested changes, not only the commented file.',
      'Update any affected proposal items so the whole preview remains coherent, consistent, and implementable.',
      'If a previously approved item must change, reset it to pending and explain why in the proposal.',
      'Keep the reviewed scope intact unless the user explicitly requested new scope.',
      'Run proposal_finalize when revised code proposal items are ready for another human preview.',
      'Do not implement source changes until all code proposal items are approved and the user submits implementation.',
    ].join('\n');
  }

  return [
    `Implement the approved proposal items from ${request.proposalPath}.`,
    '',
    `Approved item ids: ${request.approvedItemIds.join(', ')}`,
    '',
    'Before editing, read the proposal artifact and use it as the reviewed scope of work.',
    'Implement only approved items.',
    'Do not implement pending, rejected, stale, or changes-requested items.',
    'Implement only approved code proposal items. Do not implement commands, pending, rejected, stale, or changes-requested items.',
    'Do not implement if any code proposal item is not approved; update the proposal or explain what still needs review instead.',
    'Respect review comments and the exact reviewed proposed content as guidance, but apply changes using normal coding tools.',
    'If the code has drifted or the approved proposal cannot be implemented safely, use proposal_mark to mark affected items stale or changes_requested and explain why instead of inventing new scope.',
    'Run the most relevant validation you can, then use proposal_mark for applied/stale/changes_requested outcomes.',
  ].join('\n');
};

export const buildProposalImplementationUserMessage = (request: ProposalImplementationRequest) => {
  const mode = request.mode ?? 'implement';
  const kind = proposalActionKindForMode(mode);
  const metadata = {
    proposalImplementation: {
      proposalPath: request.proposalPath,
      approvedItemIds: request.approvedItemIds,
      mode,
      requestedAt: request.requestedAt,
    },
    weaveDisplay: {
      kind,
      proposalPath: request.proposalPath,
      approvedItemIds: request.approvedItemIds,
      mode,
      requestedAt: request.requestedAt,
    },
  } satisfies Record<string, unknown>;

  return {
    text: buildProposalImplementationMessage(request),
    metadata: metadata as UIMessage['metadata'],
  };
};
