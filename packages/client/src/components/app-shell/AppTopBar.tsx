import type { ReactNode } from 'react';

type AppTopBarProps = {
  leftActions?: ReactNode;
  projectName?: string;
  workspaceName?: string;
  threadTitle?: string;
  rightActions?: ReactNode;
};

export const AppTopBar = ({
  leftActions,
  projectName,
  workspaceName,
  threadTitle,
  rightActions,
}: AppTopBarProps) => (
  <header className="relative z-20 flex h-14 shrink-0 items-center justify-center border-b border-border bg-background px-4">
    {leftActions ? <div className="weave-appbar-left-actions absolute left-4 flex items-center gap-2">{leftActions}</div> : null}
    {projectName || threadTitle ? (
      <h2 className="flex max-w-[60%] items-center justify-center gap-1 truncate text-center text-sm font-semibold text-foreground">
        {projectName ? (
          <>
            <span className="min-w-0 truncate text-success">{projectName}</span>
            {workspaceName ? (
              <>
                <span className="shrink-0 text-muted-foreground">/</span>
                <span className="min-w-0 truncate text-peach">{workspaceName}</span>
              </>
            ) : null}
            {threadTitle ? <span className="shrink-0 text-muted-foreground">/</span> : null}
          </>
        ) : null}
        {threadTitle ? <span className="min-w-0 truncate text-foreground">{threadTitle}</span> : null}
      </h2>
    ) : null}
    {rightActions ? <div className="absolute right-4 flex items-center gap-3">{rightActions}</div> : null}
  </header>
);
