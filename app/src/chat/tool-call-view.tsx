import { PathLabel } from '@/components/path-label';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  AlertCircleIcon,
  ArrowDown01Icon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  ComputerTerminal01Icon,
  FileEditIcon,
} from '@hugeicons/core-free-icons';
import { useMemo } from 'react';
import type { TranscriptToolCall } from './acp-transcript';
import { ContentBlockView } from './content-block-view';
import { exitText, terminalText } from './terminal-text';
import { useTranscriptContext } from './transcript-context';
import { Badge } from '@/components/ui/badge';
import {
  Confirmation,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationTitle,
} from '@/components/ai-elements/confirmation';
import { Tool, ToolContent, ToolHeader } from '@/components/ai-elements/tool';

const statusIcon = {
  pending: Clock01Icon,
  in_progress: ArrowDown01Icon,
  completed: CheckmarkCircle02Icon,
  failed: AlertCircleIcon,
} as const;

/** A command the Host runs for the agent: its output as text, and how it ended. */
function TerminalOutput({ terminalId, running }: { terminalId: string; running: boolean }) {
  const { root } = useTranscriptContext();
  const terminal = root?.terminals[terminalId];
  const output = terminal?.output;
  const text = useMemo(() => output ? terminalText(output).replace(/\n$/, '') : '', [output]);
  const status = terminal?.exit ? exitText(terminal.exit) : running ? 'Running…' : undefined;
  return (
    <div className="overflow-hidden rounded-md border bg-input-background" data-slot="terminal-output">
      <div className="flex items-center gap-2 border-b px-2 py-1 text-[0.625rem] text-muted-foreground">
        <HugeiconsIcon icon={ComputerTerminal01Icon} strokeWidth={1.75} className="size-3" />
        <span>Terminal</span>
        {status && <span className="ml-auto">{status}</span>}
      </div>
      {terminal?.truncated && <p className="px-2 pt-1 text-[0.625rem] text-muted-foreground">Earlier output isn't shown.</p>}
      {text && (
        <pre aria-label="Terminal output" className="max-h-80 overflow-auto px-2 py-1 font-mono text-xs/relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
          {text}
        </pre>
      )}
    </div>
  );
}

function AcpToolContent({ tool }: { tool: TranscriptToolCall }) {
  return (
    <div className="flex flex-col gap-2 border-t px-3 py-2">
      {tool.locations.map((location) => (
        <div key={`${location.path}:${location.line ?? ''}`} className="flex items-center gap-2 text-[0.6875rem] text-muted-foreground">
          <HugeiconsIcon icon={FileEditIcon} strokeWidth={1.75} className="size-3" />
          <PathLabel path={location.path} />
          {location.line != null && <span className="ml-auto">:{location.line}</span>}
        </div>
      ))}
      {tool.content.map((item, index) => {
        if (item.type === 'content') {
          return <ContentBlockView key={`content-${index}`} block={item.content} />;
        }
        if (item.type === 'diff') {
          return (
            <div key={`diff-${index}`} className="overflow-hidden rounded-md border bg-input-background">
              <div className="border-b px-2 py-1 text-[0.625rem] text-muted-foreground">
                <PathLabel path={item.path} />
              </div>
              {item.oldText != null && (
                <pre className="overflow-x-auto bg-destructive-background px-2 py-1 text-xs/relaxed whitespace-pre-wrap">
                  {item.oldText}
                </pre>
              )}
              <pre className="overflow-x-auto bg-success-background px-2 py-1 text-xs/relaxed whitespace-pre-wrap">
                {item.newText}
              </pre>
            </div>
          );
        }
        return (
          <TerminalOutput
            key={`terminal-${index}`}
            terminalId={item.terminalId}
            running={tool.status === 'pending' || tool.status === 'in_progress'}
          />
        );
      })}
      {(tool.rawInput !== undefined || tool.rawOutput !== undefined) && (
        <details className="text-[0.6875rem] text-muted-foreground">
          <summary>Raw tool data</summary>
          <pre className="mt-1 overflow-x-auto rounded-md bg-input-background p-2 text-xs whitespace-pre-wrap">
            {JSON.stringify({ input: tool.rawInput, output: tool.rawOutput }, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}

export function ToolCallView({
  tool,
  onPermission,
}: {
  tool: TranscriptToolCall;
  onPermission(requestId: string, optionId: string): void;
}) {
  const permission = tool.permission;
  return (
    <Tool defaultOpen={tool.status !== 'completed'}>
      <ToolHeader className="min-h-8 gap-2 px-3 py-1.5 [&_svg]:size-3.5 [&_svg]:text-muted-foreground">
        <HugeiconsIcon data-icon="inline-start" icon={statusIcon[tool.status]} strokeWidth={1.75} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{tool.title}</span>
        <Badge variant={tool.status === 'failed' ? 'destructive' : 'outline'}>
          {tool.status.replace('_', ' ')}
        </Badge>
      </ToolHeader>
      <ToolContent>
        <AcpToolContent tool={tool} />
      </ToolContent>
      {permission?.status === 'pending' && (
        <Confirmation>
          <ConfirmationTitle>Permission required</ConfirmationTitle>
          <ConfirmationActions>
            {permission.options.map((option) => (
              <ConfirmationAction
                key={option.optionId}
                variant={option.kind.startsWith('reject') ? 'ghost' : 'outline'}
                onClick={() => onPermission(permission.requestId, option.optionId)}
              >
                {option.name}
              </ConfirmationAction>
            ))}
          </ConfirmationActions>
        </Confirmation>
      )}
    </Tool>
  );
}
