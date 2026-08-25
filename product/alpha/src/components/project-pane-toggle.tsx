import { FolderTreeIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button } from '@/components/ui/button';

export function ProjectPaneToggle({
  action,
  onClick,
}: {
  action: 'Show' | 'Hide';
  onClick(): void;
}) {
  return (
    <Button
      type='button'
      size='icon'
      variant='ghost'
      aria-label={`${action} Project Pane`}
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
