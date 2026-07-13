import type { DesktopPortalStatus } from '../shared/desktop-api';

export const statusLabel = (status: DesktopPortalStatus | undefined) => {
  if (!status) return 'Portal status unavailable';
  if (status.phase === 'starting') return 'Starting Portal';
  if (status.phase === 'ready') return `Portal ready${status.source ? ` · ${status.source}` : ''}`;
  if (status.phase === 'reconnecting') return 'Portal reconnecting';
  if (status.phase === 'failed') return 'Portal failed';
  return 'Portal idle';
};

export const portalStatusPresentation = (status: DesktopPortalStatus | undefined) => ({
  label: statusLabel(status),
  tone:
    status?.phase === 'failed'
      ? 'text-destructive'
      : status?.phase === 'ready'
        ? 'text-success'
        : 'text-muted-foreground',
  showRetry: status?.phase === 'failed',
});
