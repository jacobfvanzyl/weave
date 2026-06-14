import { lazy, Suspense } from 'react';
import type { PortalConnection } from '../../lib/chat-state-api';

const WindowStreamOverlay = lazy(() => import('./WindowStreamOverlay').then(module => ({ default: module.WindowStreamOverlay })));

type WindowStreamOverlayHostProps = {
  isActive: boolean;
  isOpen: boolean;
  portals: PortalConnection[];
  onHide: () => void;
  onSessionActiveChange: (isActive: boolean) => void;
};

export const WindowStreamOverlayHost = ({
  isActive,
  isOpen,
  portals,
  onHide,
  onSessionActiveChange,
}: WindowStreamOverlayHostProps) => isOpen || isActive ? (
  <div
    className={[
      'pointer-events-none fixed inset-0 z-50 bg-background/20 backdrop-blur-sm',
      isOpen ? '' : 'hidden',
    ].filter(Boolean).join(' ')}
    data-weave-window-stream-shell
  >
    <div className="pointer-events-auto absolute inset-0 min-h-0 min-w-0">
      <Suspense fallback={null}>
        <WindowStreamOverlay
          portals={portals}
          onHide={onHide}
          onSessionActiveChange={onSessionActiveChange}
        />
      </Suspense>
    </div>
  </div>
) : null;
