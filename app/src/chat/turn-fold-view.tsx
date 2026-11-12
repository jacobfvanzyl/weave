import { useId, type ReactNode } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowRight01Icon } from '@hugeicons/core-free-icons';
import { cn } from '@/lib/utils';
import { foldLabel, type ShownItem, type TurnFold } from './transcript-runs';

/** Which of a transcript's rows a row is, for React. */
export const shownItemKey = (item: ShownItem) => item.kind === 'entry' ? item.entry.id : item.id;

/**
 * A finished turn's work folded under one quiet row (WVE-218): "Worked for 2m 17s" with a chevron,
 * which opens to the rows it spans as the turn showed them, and closed shows only those that stay
 * in sight. Whether it's open is the pane's to keep.
 */
export function TurnFoldView({
  fold,
  open,
  onOpenChange,
  renderItem,
}: {
  fold: TurnFold;
  open: boolean;
  onOpenChange(open: boolean): void;
  renderItem(item: ShownItem): ReactNode;
}) {
  const rowsId = useId();
  const rows = open ? fold.rows : fold.rows.filter(({ hidden }) => !hidden);
  return (
    <div className="flex min-w-0 flex-col gap-4" data-slot="turn-fold" data-open={open || undefined}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={rowsId}
        onClick={() => onOpenChange(!open)}
        className="flex min-h-8 w-full min-w-0 items-center gap-1.5 rounded-md text-left text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 [&_svg]:size-3.5 [&_svg]:shrink-0"
      >
        <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className={cn('transition-transform motion-reduce:transition-none', open && 'rotate-90')} />
        <span className="min-w-0 truncate">{foldLabel(fold)}</span>
      </button>
      <div id={rowsId} hidden={rows.length === 0} className="flex min-w-0 flex-col gap-4" data-slot="turn-fold-rows">
        {rows.map(({ item }) => <div key={shownItemKey(item)} className="min-w-0">{renderItem(item)}</div>)}
      </div>
    </div>
  );
}
