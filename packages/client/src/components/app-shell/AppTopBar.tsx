import type { ReactNode } from 'react';

type AppTopBarProps = {
  centerContent?: ReactNode;
  leftActions?: ReactNode;
  projectName?: string;
  workspaceName?: string;
  threadTitle?: string;
  rightActions?: ReactNode;
};

export const AppTopBar = ({
  centerContent,
  leftActions,
  projectName,
  workspaceName,
  threadTitle,
  rightActions,
}: AppTopBarProps) => (
  <header className="weave-appbar relative z-20 grid h-14 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 border-b border-border bg-background px-4">
    <div className="weave-appbar-left-actions flex min-w-0 items-center gap-2 justify-self-start">
      {leftActions}
    </div>
    <div className="weave-appbar-center-content flex min-w-0 max-w-full items-center justify-center truncate text-center">
      {centerContent ? centerContent : projectName || threadTitle ? (
        <h2 className="flex min-w-0 max-w-full items-center justify-center gap-1 truncate text-center text-sm font-medium text-foreground">
          {projectName ? (
            <>
              <span className="min-w-0 truncate text-foreground">{projectName}</span>
              {workspaceName ? (
                <>
                  <span className="shrink-0 text-muted-foreground">/</span>
                  <span className="min-w-0 truncate text-muted-foreground">{workspaceName}</span>
                </>
              ) : null}
              {threadTitle ? <span className="shrink-0 text-muted-foreground">/</span> : null}
            </>
          ) : null}
          {threadTitle ? <span className="min-w-0 truncate text-foreground">{threadTitle}</span> : null}
        </h2>
      ) : null}
    </div>
    <div className="flex min-w-0 items-center gap-3 justify-self-end">
      {rightActions}
    </div>
  </header>
);
