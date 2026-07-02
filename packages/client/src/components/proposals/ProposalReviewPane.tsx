import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, ChevronDown, Code2, FileText, Filter, Loader2, Maximize2, MessageSquareWarning, Minimize2, Search, X } from 'lucide-react';
import { createEditorBackend } from '../../lib/editor-backend';
import type { EditorTarget } from '../../lib/editor-types';
import {
  formatProposalCompletenessIssue,
  getProposalCompleteness,
  parseProposalArtifact,
  renderProposalArtifact,
  type ParsedProposalArtifact,
} from '../../lib/proposal-artifacts';
import { cn } from '../../lib/cn';
import { useChatStore, type ThreadProposalItem } from '../../stores/chat-store';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { DiffViewer } from './DiffViewer';

type ProposalReviewPaneProps = {
  proposalPath: string;
  target: EditorTarget;
  threadId: string;
  isMaximized?: boolean;
  terminalSlot?: ReactNode;
  selectedFilePath?: string;
  onClose: () => void;
  onExpandedChange?: (isExpanded: boolean) => void;
  onOpenSource?: (path: string) => void;
};

const statusLabel = (status: string | undefined) => (status ?? 'pending').replace(/_/g, ' ');

const getDisplayPath = (path: string | undefined) => path?.split('/').filter(Boolean).pop() ?? path ?? 'Proposal item';

const codeItemKinds = new Set(['file_edit', 'file_create', 'file_delete']);
const isCodeProposalItem = (item: ThreadProposalItem) => codeItemKinds.has(item.kind);
const maxExactContentComparisonCells = 250_000;

const splitComparableLines = (value: string | undefined) => {
  if (!value) return [];
  const normalized = value.endsWith('\n') ? value.slice(0, -1) : value;
  return normalized ? normalized.split('\n') : [];
};

const countDiffChanges = (diff: string | undefined) => {
  let additions = 0;
  let deletions = 0;
  for (const line of diff?.split('\n') ?? []) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
};

const countExactContentChanges = (current: string[], proposed: string[]) => {
  let previous = new Array(proposed.length + 1).fill(0);
  let next = new Array(proposed.length + 1).fill(0);
  for (const currentLine of current) {
    for (let proposedIndex = 0; proposedIndex < proposed.length; proposedIndex += 1) {
      next[proposedIndex + 1] = currentLine === proposed[proposedIndex]
        ? previous[proposedIndex] + 1
        : Math.max(previous[proposedIndex + 1], next[proposedIndex]);
    }
    [previous, next] = [next, previous];
    next.fill(0);
  }

  const unchanged = previous[proposed.length] ?? 0;
  return {
    additions: proposed.length - unchanged,
    deletions: current.length - unchanged,
  };
};

const countBoundedContentChanges = (current: string[], proposed: string[]) => {
  let prefix = 0;
  while (prefix < current.length && prefix < proposed.length && current[prefix] === proposed[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < current.length - prefix
    && suffix < proposed.length - prefix
    && current[current.length - suffix - 1] === proposed[proposed.length - suffix - 1]
  ) {
    suffix += 1;
  }

  return {
    additions: proposed.length - prefix - suffix,
    deletions: current.length - prefix - suffix,
  };
};

const countContentChanges = (currentContent: string | undefined, proposedContent: string | undefined) => {
  const current = splitComparableLines(currentContent);
  const proposed = splitComparableLines(proposedContent);
  if (current.length === 0) return { additions: proposed.length, deletions: 0 };
  if (proposed.length === 0) return { additions: 0, deletions: current.length };

  if (current.length * proposed.length <= maxExactContentComparisonCells) {
    return countExactContentChanges(current, proposed);
  }

  return countBoundedContentChanges(current, proposed);
};

const getItemDisplayCounts = (item: ThreadProposalItem, bodyItem: ParsedProposalArtifact['bodyItems'][number] | undefined) => {
  if (bodyItem?.diff) return countDiffChanges(bodyItem.diff);
  if (item.kind === 'file_create') {
    return bodyItem?.proposedContent !== undefined
      ? { additions: splitComparableLines(bodyItem.proposedContent).length, deletions: 0 }
      : { additions: item.additions, deletions: 0 };
  }
  if (item.kind === 'file_delete') {
    return bodyItem?.currentContent !== undefined
      ? { additions: 0, deletions: splitComparableLines(bodyItem.currentContent).length }
      : { additions: 0, deletions: item.deletions };
  }
  if (bodyItem?.currentContent !== undefined || bodyItem?.proposedContent !== undefined) {
    return countContentChanges(bodyItem.currentContent, bodyItem.proposedContent);
  }
  return bodyItem?.diff ? countDiffChanges(bodyItem.diff) : { additions: item.additions, deletions: item.deletions };
};

const CountDelta = ({
  item,
  counts,
  size = 'xs',
}: {
  item: ThreadProposalItem;
  counts: { additions: number; deletions: number };
  size?: 'xs' | 'sm';
}) => (
  <>
    <span className={cn('font-mono text-success', size === 'xs' ? 'text-xs' : 'text-[11px]')}>+{counts.additions}</span>
    {item.kind === 'file_create' ? null : (
      <span className={cn('font-mono text-destructive', size === 'xs' ? 'text-xs' : 'text-[11px]')}>-{counts.deletions}</span>
    )}
  </>
);

type FeedbackDialogState = {
  itemId: string;
  initialValue: string;
};

const RequestChangesDialog = ({
  dialog,
  isSaving,
  onClose,
  onSubmit,
}: {
  dialog: FeedbackDialogState | null;
  isSaving: boolean;
  onClose: () => void;
  onSubmit: (itemId: string, comment: string) => void;
}) => {
  const [value, setValue] = useState('');

  useEffect(() => {
    setValue(dialog?.initialValue ?? '');
  }, [dialog?.itemId, dialog?.initialValue]);

  return (
    <Dialog open={Boolean(dialog)} onOpenChange={open => !open && onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Request changes</DialogTitle>
          <DialogDescription>
            Add file-level feedback for the agent to address in a revised proposal.
          </DialogDescription>
        </DialogHeader>
        <div className="px-5 pb-1 pt-1" data-slot="dialog-panel">
          <Textarea
            autoFocus
            value={value}
            placeholder="Describe what should change in this file..."
            onChange={event => setValue(event.currentTarget.value)}
          />
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button onClick={() => dialog && onSubmit(dialog.itemId, value)} disabled={!value.trim() || isSaving}>
            Save feedback
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};

export const ProposalReviewPane = ({
  proposalPath,
  target,
  threadId,
  isMaximized = false,
  terminalSlot,
  selectedFilePath,
  onClose,
  onExpandedChange,
  onOpenSource,
}: ProposalReviewPaneProps) => {
  const codeBackend = useMemo(() => createEditorBackend(), []);
  const setThreadProposal = useChatStore(state => state.setThreadProposal);
  const observedProposalHash = useChatStore(state => state.threadProposals[threadId]?.contentHash);
  const enqueueProposalImplementationRequest = useChatStore(state => state.enqueueProposalImplementationRequest);
  const pendingImplementationRequest = useChatStore(state => state.pendingProposalImplementationRequests[threadId]);
  const isThreadRunning = useChatStore(state => state.runningThreadIds.includes(threadId));
  const [proposal, setProposal] = useState<ParsedProposalArtifact | null>(null);
  const [artifactVersion, setArtifactVersion] = useState<string | undefined>();
  const [selectedItemId, setSelectedItemId] = useState<string | undefined>();
  const [filter, setFilter] = useState('');
  const [feedbackDialog, setFeedbackDialog] = useState<FeedbackDialogState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const proposalRef = useRef<ParsedProposalArtifact | null>(null);
  const targetKey = [
    target.projectId,
    target.workspaceId,
    target.portalId ?? '',
    target.rootId ?? '',
    target.repoPath ?? '',
    target.workspacePath ?? '',
  ].join('\0');

  useEffect(() => {
    let cancelled = false;
    if (!proposalRef.current) setIsLoading(true);
    setError(null);
    void codeBackend.read(target, proposalPath)
      .then(file => {
        if (cancelled) return;
        const parsed = parseProposalArtifact(file.content);
        const firstCodeItem = selectedFilePath
          ? parsed.items.find(item => isCodeProposalItem(item) && item.path === selectedFilePath) ?? parsed.items.find(isCodeProposalItem)
          : parsed.items.find(isCodeProposalItem);
        proposalRef.current = parsed;
        setProposal(parsed);
        setArtifactVersion(file.version);
        setSelectedItemId(previous => {
          if (selectedFilePath) return firstCodeItem?.id;
          return parsed.items.some(item => item.id === previous && isCodeProposalItem(item)) ? previous : firstCodeItem?.id;
        });
        setThreadProposal(threadId, parsed);
      })
      .catch(reason => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [codeBackend, observedProposalHash, proposalPath, selectedFilePath, setThreadProposal, targetKey, threadId]);

  const persistItems = useCallback(async (items: ThreadProposalItem[]) => {
    if (!proposal) return;
    setIsSaving(true);
    setError(null);
    try {
      const nextContent = renderProposalArtifact(proposal, items);
      const write = await codeBackend.write(target, proposalPath, nextContent, artifactVersion);
      const parsed = parseProposalArtifact(nextContent);
      proposalRef.current = parsed;
      setProposal(parsed);
      setArtifactVersion(write.version);
      setThreadProposal(threadId, parsed);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setIsSaving(false);
    }
  }, [artifactVersion, codeBackend, proposal, proposalPath, setThreadProposal, target, threadId]);

  const updateItem = useCallback((itemId: string, update: Partial<ThreadProposalItem>) => {
    if (!proposal) return;
    void persistItems(proposal.items.map(item => item.id === itemId ? { ...item, ...update } : item));
  }, [persistItems, proposal]);

  const codeItems = useMemo(() => proposal?.items.filter(isCodeProposalItem) ?? [], [proposal]);
  const bodyById = useMemo(() => new Map((proposal?.bodyItems ?? []).map(item => [item.id, item])), [proposal]);
  const completeness = useMemo(
    () => getProposalCompleteness(codeItems, proposal?.bodyItems ?? []),
    [codeItems, proposal?.bodyItems],
  );
  const completenessById = useMemo(
    () => new Map(completeness.items.map(item => [item.itemId, item])),
    [completeness],
  );
  const firstBlockingCompletenessIssue = completeness.blockingIssues[0];
  const firstActionableIncompleteIssue = completeness.items.find(item => item.requiresCompleteness && !item.complete)?.issues[0];

  const approveAll = useCallback(() => {
    if (!proposal) return;
    if (firstActionableIncompleteIssue) {
      setError(formatProposalCompletenessIssue(firstActionableIncompleteIssue));
      return;
    }
    void persistItems(proposal.items.map(item =>
      isCodeProposalItem(item) && item.status === 'pending'
        ? { ...item, status: 'approved' }
        : item,
    ));
  }, [firstActionableIncompleteIssue, persistItems, proposal]);

  const submitFeedback = useCallback((itemId: string, value: string) => {
    if (!proposal || !value.trim()) return;
    const comment = value.trim();
    setFeedbackDialog(null);
    void persistItems(proposal.items.map(item =>
      item.id === itemId && isCodeProposalItem(item)
        ? { ...item, status: 'changes_requested', comment }
        : item,
    ));
  }, [persistItems, proposal]);

  const submitReview = useCallback(() => {
    if (!proposal) return;
    const codeItems = proposal.items.filter(isCodeProposalItem);
    if (firstBlockingCompletenessIssue) {
      setError(formatProposalCompletenessIssue(firstBlockingCompletenessIssue));
      return;
    }
    const hasFeedback = codeItems.some(item => item.status === 'changes_requested');
    if (hasFeedback) {
      enqueueProposalImplementationRequest(threadId, {
        proposalPath,
        approvedItemIds: codeItems.filter(item => item.status === 'approved').map(item => item.id),
        mode: 'address_feedback',
      });
      onClose();
      return;
    }

    const unapprovedCount = codeItems.filter(item => item.status !== 'approved' && item.status !== 'applied').length;
    if (unapprovedCount > 0) {
      setError(`Approve all code proposals before submitting implementation. ${unapprovedCount} still need review.`);
      return;
    }
    const approvedItemIds = codeItems.filter(item => item.status === 'approved').map(item => item.id);
    if (approvedItemIds.length === 0) {
      setError('There are no approved code proposals to implement.');
      return;
    }
    enqueueProposalImplementationRequest(threadId, {
      proposalPath,
      approvedItemIds,
      mode: 'implement',
    });
    onClose();
  }, [enqueueProposalImplementationRequest, firstBlockingCompletenessIssue, onClose, proposal, proposalPath, threadId]);

  const hasFeedback = codeItems.some(item => item.status === 'changes_requested');
  const allCodeItemsApproved = codeItems.length > 0 && codeItems.every(item => item.status === 'approved' || item.status === 'applied');
  const hasPendingImplementation = Boolean(pendingImplementationRequest);
  const canSubmitReview = Boolean(
    proposal
      && codeItems.length > 0
      && (hasFeedback || allCodeItemsApproved)
      && !firstBlockingCompletenessIssue
      && !isSaving
      && !isThreadRunning
      && !hasPendingImplementation,
  );

  const submitLabel = isThreadRunning
    ? 'Agent running'
    : hasPendingImplementation
      ? 'Queued'
      : 'Submit';

  const submitTitle = firstBlockingCompletenessIssue
    ? formatProposalCompletenessIssue(firstBlockingCompletenessIssue)
    : hasFeedback
      ? 'Send review feedback to the agent'
      : allCodeItemsApproved
        ? 'Start the agent to implement approved code proposals'
        : 'Approve all code proposals or request changes before submitting';

  const filteredItems = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!codeItems.length) return [];
    return query
      ? codeItems.filter(item => [item.title, item.path, item.status].filter(Boolean).join(' ').toLowerCase().includes(query))
      : codeItems;
  }, [codeItems, filter]);

  const selectedItem = codeItems.find(item => item.id === selectedItemId) ?? filteredItems[0];
  const selectedBody = proposal?.bodyItems.find(item => item.id === selectedItem?.id);
  const selectedCompleteness = selectedItem ? completenessById.get(selectedItem.id) : undefined;
  const selectedCompletenessIssue = selectedCompleteness?.issues[0];
  const selectedCounts = selectedItem ? getItemDisplayCounts(selectedItem, selectedBody) : undefined;
  const counts = filteredItems.reduce((acc, item) => {
    const itemCounts = getItemDisplayCounts(item, bodyById.get(item.id));
    acc.additions += itemCounts.additions;
    acc.deletions += itemCounts.deletions;
    return acc;
  }, { additions: 0, deletions: 0 });

  return (
    <div
      key="proposal-review"
      className="flex min-h-0 min-w-0 flex-1 basis-0 flex-col overflow-hidden bg-background"
      data-weave-main-pane="editor"
      data-maximized={isMaximized ? 'true' : 'false'}
      data-weave-surface="proposal-review"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
          <MessageSquareWarning size={15} className="shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 truncate text-sm font-medium">
            {proposal?.title ?? 'Proposal review'}
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={approveAll}
            disabled={!proposal || isSaving || Boolean(firstActionableIncompleteIssue) || codeItems.every(item => item.status !== 'pending')}
            title={firstActionableIncompleteIssue ? formatProposalCompletenessIssue(firstActionableIncompleteIssue) : 'Approve all pending code proposals'}
          >
            Approve all
          </Button>
          <Button
            size="sm"
            onClick={submitReview}
            disabled={!canSubmitReview}
            title={submitTitle}
            className={cn(allCodeItemsApproved && !hasFeedback && 'border-success-button bg-success-button text-[#11111b] hover:bg-success-button/90')}
          >
            {submitLabel}
          </Button>
          {isSaving ? <Loader2 size={14} className="animate-spin text-primary" /> : null}
          {onExpandedChange ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={isMaximized ? 'Restore proposal review' : 'Maximize proposal review'}
              title={isMaximized ? 'Restore proposal review' : 'Maximize proposal review'}
              onClick={() => onExpandedChange(!isMaximized)}
            >
              {isMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </Button>
          ) : null}
          <Button size="icon-xs" variant="ghost" aria-label="Close proposal review" title="Close proposal review" onClick={onClose}>
            <X size={14} />
          </Button>
        </div>

        {error ? (
          <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive-foreground">
            {error}
          </div>
        ) : firstBlockingCompletenessIssue ? (
          <div className="flex items-center gap-2 border-b border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
            <AlertTriangle size={14} className="shrink-0" />
            <span>{formatProposalCompletenessIssue(firstBlockingCompletenessIssue)}</span>
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
            <div className="min-w-0 flex-1 truncate font-mono text-sm text-muted-foreground">
              {selectedItem?.path ?? selectedItem?.title ?? proposalPath}
            </div>
            {selectedItem ? (
              <>
                <CountDelta item={selectedItem} counts={selectedCounts ?? selectedItem} />
                <Button
                  size="sm"
                  variant={selectedItem.status === 'approved' ? 'default' : 'outline'}
                  disabled={
                    selectedItem.status === 'changes_requested'
                    || isSaving
                    || (selectedItem.status !== 'approved' && selectedCompleteness?.complete === false)
                  }
                  title={
                    selectedItem.status !== 'approved' && selectedCompletenessIssue
                      ? formatProposalCompletenessIssue(selectedCompletenessIssue)
                      : selectedItem.status === 'approved'
                        ? 'Unapprove this file'
                        : 'Approve this file'
                  }
                  className={cn(
                    selectedItem.status === 'approved' && 'border-success-button bg-success-button text-[#11111b] hover:bg-success-button/90',
                  )}
                  onClick={() => {
                    if (selectedItem.status !== 'approved' && selectedCompletenessIssue) {
                      setError(formatProposalCompletenessIssue(selectedCompletenessIssue));
                      return;
                    }
                    updateItem(selectedItem.id, {
                      status: selectedItem.status === 'approved' ? 'pending' : 'approved',
                      viewed: true,
                      ...(selectedItem.status === 'approved' ? {} : { comment: undefined }),
                    });
                  }}
                >
                  <Check size={14} />
                  {selectedItem.status === 'approved' ? 'Approved' : 'Approve'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className={cn(
                    selectedItem.status === 'changes_requested' && 'border-warning bg-warning text-[#11111b] hover:bg-warning/90',
                  )}
                  onClick={() => setFeedbackDialog({ itemId: selectedItem.id, initialValue: selectedItem.comment ?? '' })}
                >
                  Request changes
                </Button>
                {selectedItem.path && onOpenSource ? (
                  <Button size="icon-sm" variant="ghost" aria-label="Open source file" title="Open source file" onClick={() => onOpenSource(selectedItem.path!)}>
                    <Code2 size={14} />
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
          {selectedBody?.description ? (
            <div className="shrink-0 border-b border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              {selectedBody.description}
            </div>
          ) : null}
          {selectedCompletenessIssue ? (
            <div className="flex shrink-0 items-center gap-2 border-b border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
              <AlertTriangle size={13} className="shrink-0" />
              <span>{formatProposalCompletenessIssue(selectedCompletenessIssue)}</span>
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-hidden">
            {isLoading ? (
              <div className="grid h-full place-items-center text-sm text-muted-foreground">
                <Loader2 size={18} className="animate-spin" />
              </div>
            ) : selectedItem ? (
              <DiffViewer
                path={selectedItem.path}
                originalText={selectedBody?.currentContent ?? ''}
                proposedText={selectedBody?.proposedContent ?? selectedBody?.diff ?? ''}
              />
            ) : (
              <div className="grid h-full place-items-center text-sm text-muted-foreground">No proposal item selected</div>
            )}
          </div>
        </div>

        <aside className="flex w-80 shrink-0 flex-col border-l border-border bg-card/50" data-weave-proposal-explorer>
          <div className="shrink-0 border-b border-border p-3">
            <Input
              nativeInput
              size="sm"
              type="search"
              value={filter}
              placeholder="Filter files..."
              onChange={event => setFilter(event.currentTarget.value)}
            />
          </div>
          <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3 text-xs text-muted-foreground">
            <Filter size={13} />
            <span className="min-w-0 flex-1 truncate">{filteredItems.length} file{filteredItems.length === 1 ? '' : 's'}</span>
            <span className="font-mono text-success">+{counts.additions ?? 0}</span>
            {counts.deletions > 0 ? <span className="font-mono text-destructive">-{counts.deletions}</span> : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            <div className="mb-1 flex items-center gap-1 px-2 text-xs font-medium text-muted-foreground">
              <ChevronDown size={14} />
              Proposed changes
            </div>
            {filteredItems.map(item => {
              const itemCompleteness = completenessById.get(item.id);
              const itemIssue = itemCompleteness?.issues[0];
              return (
                <button
                  key={item.id}
                  type="button"
                  className={cn(
                    'flex h-9 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground',
                    selectedItem?.id === item.id && 'bg-muted text-foreground',
                    itemIssue && 'text-warning hover:text-warning',
                  )}
                  title={itemIssue ? formatProposalCompletenessIssue(itemIssue) : undefined}
                  onClick={() => {
                    setSelectedItemId(item.id);
                    if (!item.viewed) updateItem(item.id, { viewed: true });
                  }}
                >
                  <FileText size={14} className="shrink-0 text-primary" />
                  <span className="min-w-0 flex-1 truncate">{getDisplayPath(item.path)}</span>
                  {itemIssue ? <AlertTriangle size={13} className="shrink-0 text-warning" /> : null}
                  <CountDelta item={item} counts={getItemDisplayCounts(item, bodyById.get(item.id))} size="sm" />
                  <span
                    className={cn(
                      'h-2 w-2 shrink-0 rounded-full border border-border',
                      item.viewed && 'bg-primary',
                      item.status === 'approved' && 'bg-success',
                      item.status === 'changes_requested' && 'bg-warning',
                      item.status === 'rejected' && 'bg-destructive',
                      item.status === 'applied' && 'bg-success',
                      item.status === 'stale' && 'bg-warning',
                      itemIssue && 'border-warning bg-warning',
                    )}
                    title={`${statusLabel(item.status)}${item.viewed ? ', viewed' : ''}${itemIssue ? ', incomplete' : ''}`}
                  />
                </button>
              );
            })}
            {!filteredItems.length ? (
              <div className="flex h-24 flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
                <Search size={16} />
                No files match
              </div>
            ) : null}
          </div>
        </aside>
        </div>
      </div>
      {terminalSlot}
      <RequestChangesDialog
        dialog={feedbackDialog}
        isSaving={isSaving}
        onClose={() => setFeedbackDialog(null)}
        onSubmit={submitFeedback}
      />
    </div>
  );
};
