import { CircleCheck, CircleDot, Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import { Button } from '@weave/client/components/ui/button';
import type { DesktopPortalStatus } from '../shared/desktop-api';
import { portalStatusPresentation } from './portal-status';

const StatusIcon = ({ status }: { status: DesktopPortalStatus | undefined }) => {
  if (!status || status.phase === 'idle') return <CircleDot size={14} />;
  if (status.phase === 'starting' || status.phase === 'reconnecting') {
    return <Loader2 className="animate-spin" size={14} />;
  }
  if (status.phase === 'ready') return <CircleCheck size={14} />;
  return <TriangleAlert size={14} />;
};

export const PortalStatusIndicator = ({
  onRetry,
  retrying,
  status,
}: {
  onRetry: () => void | Promise<void>;
  retrying: boolean;
  status: DesktopPortalStatus | undefined;
}) => {
  const { label, tone, showRetry } = portalStatusPresentation(status);

  return (
    <div className="rounded-md border border-border bg-muted/30 p-3 text-sm">
      <div className={`flex items-center gap-2 font-medium ${tone}`}>
        <StatusIcon status={status} />
        <span>{label}</span>
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {status?.serverUrl
          ? `${status.serverUrl}${status.source ? ` · ${status.source}` : ''}`
          : 'Waiting for Desktop connection settings.'}
      </div>
      {status?.error ? (
        <div className="mt-2 max-h-24 overflow-auto break-words text-xs text-destructive">{status.error}</div>
      ) : null}
      {showRetry ? (
        <Button
          className="mt-3"
          disabled={retrying}
          size="sm"
          type="button"
          variant="outline"
          onClick={() => void onRetry()}
        >
          <RefreshCw className={retrying ? 'animate-spin' : undefined} size={14} />
          Retry Portal
        </Button>
      ) : null}
    </div>
  );
};
