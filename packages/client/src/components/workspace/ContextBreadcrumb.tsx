import { cn } from '../../lib/cn';

type ContextBreadcrumbProps = {
  className?: string;
  projectName?: string;
  threadTitle?: string;
  workspaceName?: string;
};

export const ContextBreadcrumb = ({
  className,
  projectName,
  threadTitle,
  workspaceName,
}: ContextBreadcrumbProps) => {
  if (!projectName && !threadTitle) return null;

  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-1 truncate text-sm font-medium text-foreground',
        className,
      )}
      data-weave-context-breadcrumb
      data-weave-context-has-thread-title={threadTitle ? 'true' : 'false'}
    >
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
    </div>
  );
};
