import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AlphaWorkspaceFileTab } from '@/app/alpha-controller';
import { EditorPane } from './editor-pane';

const textFile = (
  path: string,
  content: string,
  changed = false,
): AlphaWorkspaceFileTab => ({
  kind: 'text',
  path,
  content,
  contentHash: '0'.repeat(64),
  size: new TextEncoder().encode(content).byteLength,
  changed,
});

function EditorHarness({ initialFiles }: { initialFiles: AlphaWorkspaceFileTab[] }) {
  const [files, setFiles] = useState(initialFiles);
  const [activeFilePath, setActiveFilePath] = useState(initialFiles[0]?.path);

  const closeFile = (path: string) => {
    setFiles((current) => {
      const closingIndex = current.findIndex((file) => file.path === path);
      if (path === activeFilePath) {
        setActiveFilePath(current[closingIndex + 1]?.path ?? current[closingIndex - 1]?.path);
      }
      return current.filter((file) => file.path !== path);
    });
  };

  return (
    <EditorPane
      files={files}
      activeFilePath={activeFilePath}
      busy={false}
      onActivateFile={setActiveFilePath}
      onCloseFile={closeFile}
      onReloadFile={vi.fn()}
      onReturnToThread={vi.fn()}
    />
  );
}

describe('EditorPane', () => {
  it('switches and closes multiple file tabs with nearest-tab fallback', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <EditorHarness
        initialFiles={[
          textFile('README.md', '# Weave\n'),
          textFile('src/main.ts', 'export {};\n'),
        ]}
      />,
    );

    expect(container.querySelector('[data-slot="editor-pane"]')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'README.md' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('# Weave')).toBeInTheDocument();
    expect(container.querySelector('ol')).toHaveClass('list-decimal');
    expect(container.querySelector('[data-slot="tabs-list"]')).toHaveAttribute(
      'data-variant',
      'editor',
    );
    expect(container.querySelector('[data-slot="editor-tab-rail"]')).toHaveClass(
      'h-full',
      'overflow-x-auto',
      'overflow-y-hidden',
      'scrollbar-none',
    );
    expect(screen.getByRole('tab', { name: 'README.md' }).closest('[data-slot="editor-tab"]'))
      .toHaveAttribute('data-active');
    expect(screen.getByRole('tab', { name: 'README.md' }).closest('[data-slot="editor-tab"]'))
      .toHaveClass('bg-background');
    expect(screen.getByRole('tab', { name: 'main.ts' }).closest('[data-slot="editor-tab"]'))
      .not.toHaveAttribute('data-active');

    screen.getByRole('tab', { name: 'README.md' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'main.ts' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('tab', { name: 'main.ts' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'main.ts' }).closest('[data-slot="editor-tab"]'))
      .toHaveClass('bg-background');
    expect(screen.getByRole('tab', { name: 'README.md' }).closest('[data-slot="editor-tab"]'))
      .not.toHaveClass('bg-background');
    expect(screen.getByText('export {};')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close src/main.ts' }));
    expect(screen.getByRole('tab', { name: 'README.md' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('tab', { name: 'main.ts' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close README.md' }));
    expect(container.querySelector('[data-slot="editor-pane"]')).not.toBeInTheDocument();
  });

  it('keeps changed content stable until reload is requested', async () => {
    const user = userEvent.setup();
    const reload = vi.fn();
    render(
      <EditorPane
        files={[textFile('src/main.ts', 'export {};\n', true)]}
        activeFilePath='src/main.ts'
        busy={false}
        onActivateFile={vi.fn()}
        onCloseFile={vi.fn()}
        onReloadFile={reload}
        onReturnToThread={vi.fn()}
      />,
    );

    expect(screen.getByText('File changed on the Host')).toBeInTheDocument();
    expect(screen.getByText('export {};')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reload file' }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it('shows unsupported files in the active Editor Pane tab', () => {
    render(
      <EditorPane
        files={[{ kind: 'unavailable', path: 'src/image.bin', reason: 'unsupported' }]}
        activeFilePath='src/image.bin'
        busy={false}
        onActivateFile={vi.fn()}
        onCloseFile={vi.fn()}
        onReloadFile={vi.fn()}
        onReturnToThread={vi.fn()}
      />,
    );

    expect(screen.getByRole('tab', { name: 'image.bin' })).toBeInTheDocument();
    expect(screen.getByText('Preview unavailable')).toBeInTheDocument();
    expect(screen.getByText('This file is not UTF-8 text.')).toBeInTheDocument();
  });
});
