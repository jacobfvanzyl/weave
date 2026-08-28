import { FolderTreeIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function ProjectPaneToggle({
  action,
  capacitorInset = false,
  disabled = false,
  onClick,
}: {
  action: 'Show' | 'Hide';
  capacitorInset?: boolean;
  disabled?: boolean;
  onClick(): void;
}) {
  return (
    <Button
      type='button'
      size='icon'
      variant='ghost'
      aria-label={`${action} Project Pane`}
      className={cn(capacitorInset && 'mr-6')}
      disabled={disabled}
      onClick={onClick}
    >
      <HugeiconsIcon
        data-icon='inline-start'
        data-symbol='project-pane'
        icon={FolderTreeIcon}
        strokeWidth={2}
      />
    </Button>
  );
}
