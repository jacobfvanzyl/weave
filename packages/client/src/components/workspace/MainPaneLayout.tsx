import { Children, type ReactNode } from 'react';

type MainPaneLayoutProps = {
  children: ReactNode;
  emptyState?: ReactNode;
  isEmpty: boolean;
};

export const MainPaneLayout = ({ children, emptyState, isEmpty }: MainPaneLayoutProps) => {
  const panes = Children.toArray(children);
  const paneChildren = panes.flatMap((pane, index) => (
    index === 0
      ? [pane]
      : [
        <div
          key={`main-pane-divider-${index}`}
          className="w-px shrink-0 bg-border"
          aria-hidden="true"
          data-weave-main-pane-divider
        />,
        pane,
      ]
  ));

  return (
    <div className="flex min-h-0 flex-1">
      {paneChildren}
      {isEmpty ? emptyState : null}
    </div>
  );
};
