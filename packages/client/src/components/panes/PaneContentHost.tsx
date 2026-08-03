import type { ComponentPropsWithoutRef, ReactNode } from 'react';

export type PaneContentType = 'thread' | 'editor' | 'terminal';

export type PaneHostIdentity = Readonly<{
  paneId: string;
  workspaceId: string;
}>;

export type PaneHostLifecycle = Readonly<{
  focusRequest: number;
  onClose: () => void;
}>;

type PaneContentHostProps = Omit<ComponentPropsWithoutRef<'div'>, 'children'> & {
  children: ReactNode;
  identity: PaneHostIdentity;
  paneType: PaneContentType;
};

export const PaneContentHost = ({
  children,
  identity,
  paneType,
  ...props
}: PaneContentHostProps) => (
  <div
    {...props}
    data-weave-pane-host={paneType}
    data-weave-pane-id={identity.paneId}
    data-weave-workspace-id={identity.workspaceId}
  >
    {children}
  </div>
);
