import { FolderTreeIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button } from '@/components/ui/button';

export function ProjectPaneToggle({
  action,
  disabled = false,
  onClick,
}: {
  action: 'Show' | 'Hide';
  disabled?: boolean;
  onClick(): void;
}) {
  return (
    <Button
      type='button'
      size='icon'
      variant='ghost'
      aria-label={`${action} Project Pane`}
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
