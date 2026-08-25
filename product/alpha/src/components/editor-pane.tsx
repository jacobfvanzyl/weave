import { HugeiconsIcon } from '@hugeicons/react';
import {
  AiFile01Icon,
  ArrowLeft01Icon,
  Cancel01Icon,
} from '@hugeicons/core-free-icons';
import type { AlphaWorkspaceFileTab } from '@/app/alpha-controller';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

const fileName = (path: string) => path.split('/').at(-1) || path;

function FileContent({ file }: { file: Extract<AlphaWorkspaceFileTab, { kind: 'text' }> }) {
  return (
    <div
      className='min-h-0 flex-1 overflow-auto bg-background px-3 py-2 font-mono text-xs/6'
      role='region'
      aria-label={`${file.path} read-only preview`}
    >
      <ol className='min-w-max list-decimal pl-10 marker:select-none marker:text-muted-foreground'>
        {file.content.split('\n').map((line, index) => (
          <li key={index} className='pl-4 pr-8'>
            <code className='whitespace-pre'>{line || '\u00a0'}</code>
          </li>
        ))}
      </ol>
    </div>
  );
}

function UnavailableContent({ file }: { file: Extract<AlphaWorkspaceFileTab, { kind: 'unavailable' }> }) {
  return (
    <div className='flex min-h-0 flex-1 items-center justify-center p-6'>
      <Empty className='max-w-sm'>
        <EmptyHeader>
          <EmptyMedia variant='icon'>
            <HugeiconsIcon icon={AiFile01Icon} strokeWidth={1.75} />
          </EmptyMedia>
          <EmptyTitle>Preview unavailable</EmptyTitle>
          <EmptyDescription>
            {file.reason === 'unsupported'
              ? 'This file is not UTF-8 text.'
              : 'This file is too large to preview.'}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}

export function EditorPane({
  files,
  activeFilePath,
  busy,
  className,
  onActivateFile,
  onCloseFile,
  onReloadFile,
  onReturnToThread,
}: {
  files: AlphaWorkspaceFileTab[];
  activeFilePath?: string;
  busy: boolean;
  className?: string;
  onActivateFile(path: string): void;
  onCloseFile(path: string): void;
  onReloadFile(): void;
  onReturnToThread(): void;
}) {
  const activeFile = files.find((file) => file.path === activeFilePath) ?? files[0];
  if (!activeFile) return null;

  return (
    <Tabs
      value={activeFile.path}
      onValueChange={onActivateFile}
      className={cn('min-h-0 min-w-0 flex-1 gap-0 border-l bg-background', className)}
      role='region'
      aria-label='Editor Pane'
      data-slot='editor-pane'
    >
      <header className='flex h-11 shrink-0 items-center border-b bg-title-bar'>
        <Button
          type='button'
          size='icon-sm'
          variant='ghost'
          className='ml-1 md:hidden'
          aria-label='Return to Thread'
          onClick={onReturnToThread}
        >
          <HugeiconsIcon data-icon='inline-start' icon={ArrowLeft01Icon} strokeWidth={2} />
        </Button>
        <div
          className='scrollbar-none h-full min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-hidden'
          data-slot='editor-tab-rail'
        >
          <TabsList
            variant='editor'
            className='h-full! w-max'
            aria-label='Open files'
          >
            {files.map((file) => (
              <div
                key={file.path}
                data-slot='editor-tab'
                data-active={file.path === activeFile.path ? '' : undefined}
                className={cn(
                  'flex h-full min-w-0 items-center',
                  file.path === activeFile.path && 'bg-background',
                )}
              >
                <TabsTrigger
                  value={file.path}
                  title={file.path}
                  className='max-w-48 flex-none'
                >
                  <span className='truncate'>{fileName(file.path)}</span>
                  {file.kind === 'text' && file.changed && (
                    <span className='text-muted-foreground' aria-label='Changed on the Host'>●</span>
                  )}
                </TabsTrigger>
                <Button
                  type='button'
                  size='icon-xs'
                  variant='ghost'
                  className='mr-1'
                  aria-label={`Close ${file.path}`}
                  onClick={() => onCloseFile(file.path)}
                >
                  <HugeiconsIcon data-icon='inline-start' icon={Cancel01Icon} strokeWidth={2} />
                </Button>
              </div>
            ))}
          </TabsList>
        </div>
      </header>

      <TabsContent value={activeFile.path} className='flex min-h-0 flex-1 flex-col overflow-hidden'>
        {activeFile.kind === 'text' && activeFile.changed && (
          <Alert className='m-2 w-auto shrink-0'>
            <AlertTitle>File changed on the Host</AlertTitle>
            <AlertDescription>Reload to see the latest content.</AlertDescription>
            <AlertAction>
              <Button
                type='button'
                size='xs'
                variant='outline'
                aria-label='Reload file'
                disabled={busy}
                onClick={onReloadFile}
              >
                Reload
              </Button>
            </AlertAction>
          </Alert>
        )}
        {activeFile.kind === 'text'
          ? <FileContent file={activeFile} />
          : <UnavailableContent file={activeFile} />}
      </TabsContent>

      <footer
        className='h-[var(--bottom-rail-height)] shrink-0 border-t bg-status-bar'
        data-slot='editor-bottom-rail'
      />
    </Tabs>
  );
}
