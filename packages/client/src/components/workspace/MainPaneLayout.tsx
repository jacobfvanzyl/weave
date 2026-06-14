import type { ReactNode } from 'react';

type MainPaneLayoutProps = {
  children: ReactNode;
  emptyState?: ReactNode;
  isEmpty: boolean;
};

export const MainPaneLayout = ({ children, emptyState, isEmpty }: MainPaneLayoutProps) => (
  <div className="flex min-h-0 flex-1">
    {children}
    {isEmpty ? emptyState : null}
  </div>
);
