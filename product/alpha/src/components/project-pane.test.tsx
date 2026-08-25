import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AlphaWorkspaceFiles } from '@/app/alpha-controller';
import { SidebarProvider } from '@/components/ui/sidebar';
import { ProjectPane } from './project-pane';

const files: AlphaWorkspaceFiles = {
  workspaceId: 'weave',
  workspaceName: 'Weave',
  activeFilePath: 'src/main.ts',
  openFiles: [{
    kind: 'text',
    path: 'src/main.ts',
    content: 'export {};\n',
    contentHash: '0'.repeat(64),
    size: 11,
    changed: false,
  }],
  directories: {
    '': {
      entries: [
        { name: 'src', path: 'src', type: 'directory' },
        { name: 'README.md', path: 'README.md', type: 'file', size: 11 },
      ],
      truncated: false,
    },
    src: {
      entries: [
        { name: 'nested', path: 'src/nested', type: 'directory' },
        { name: 'main.ts', path: 'src/main.ts', type: 'file', size: 11 },
      ],
      truncated: false,
    },
  },
};

describe('ProjectPane', () => {
  it('expands directories in place with nesting guides without presenting file content', async () => {
    const user = userEvent.setup();
    const openDirectory = vi.fn();
    const openFile = vi.fn();
    const { container } = render(
      <SidebarProvider>
        <ProjectPane
          files={files}
          busy={false}
          onOpenDirectory={openDirectory}
          onOpenFile={openFile}
        />
      </SidebarProvider>,
    );

    expect(container.querySelector('[data-slot="project-pane"][data-side="right"]'))
      .toBeInTheDocument();
    expect(container.querySelector('[data-slot="project-pane"]')).toHaveClass(
      'w-full',
      'border-l-0',
    );
    expect(container.querySelector('[data-slot="sidebar-footer"]')).toHaveClass(
      'h-[var(--bottom-rail-height)]',
      'bg-status-bar',
    );
    expect(container.querySelector('[data-slot="sidebar-footer"]')).not.toHaveClass('border-l');
    const toggle = screen.getByRole('button', { name: 'Hide Project Pane' });
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveTextContent('');
    expect(toggle).toHaveClass('size-7', 'items-center', 'justify-center');
    expect(container.querySelectorAll('[data-symbol="project-pane"]')).toHaveLength(2);
    expect(screen.queryByText('11 B')).not.toBeInTheDocument();
    expect(screen.queryByText('export {};')).not.toBeInTheDocument();
    expect(screen.queryByText('Read only')).not.toBeInTheDocument();
    expect(screen.queryByText('main.ts')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Expand directory src' }));
    expect(screen.getByText('main.ts')).toBeInTheDocument();
    expect(container.querySelector('[data-indent-indicator="true"]')).toHaveClass('border-l');
    expect(screen.getByText('Weave')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Go to parent directory' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Expand directory nested' }));
    expect(openDirectory).toHaveBeenCalledWith('src/nested');
    await user.click(screen.getByRole('button', { name: 'Open file main.ts' }));
    expect(openFile).toHaveBeenCalledWith('src/main.ts');
    await user.click(screen.getByRole('button', { name: 'Collapse directory src' }));
    expect(screen.queryByText('main.ts')).not.toBeInTheDocument();
  });

  it('shows the directory name only once and disappears entirely when hidden', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <SidebarProvider>
        <ProjectPane
          files={{ ...files, activeFilePath: undefined, openFiles: [] }}
          busy={false}
          onOpenDirectory={vi.fn()}
          onOpenFile={vi.fn()}
        />
      </SidebarProvider>,
    );

    expect(screen.getAllByText('Weave')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Hide Project Pane' }));
    expect(container.querySelector('[data-slot="project-pane"]')).not.toBeInTheDocument();
    expect(screen.queryByText('Weave')).not.toBeInTheDocument();
  });

});
