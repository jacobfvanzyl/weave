import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { TerminalLayoutNode } from '@weave/product-protocol';
import { WorkspacePaneLayout } from './workspace-pane-layout';

it('reserves one shared gutter per internal edge and none on outer or maximized edges', () => {
  const pane = (id: string): TerminalLayoutNode => ({ kind: 'terminal', executionContextId: 'workspace', nodeId: id, paneId: id, terminalId: id });
  const layout: TerminalLayoutNode = { kind: 'split', nodeId: 'rows', axis: 'vertical', ratio: 0.5, children: [pane('top'), {
    kind: 'split', nodeId: 'columns', axis: 'horizontal', ratio: 0.5, children: [pane('left'), pane('right')],
  }] };
  const props = { layout, active: true, setRatio: vi.fn(), renderPane: (node: { paneId: string }) => <div>{node.paneId}</div> };
  const view = render(<WorkspacePaneLayout {...props} />);
  const bounds = (id: string) => (view.container.querySelector(`[data-pane-id="${id}"]`) as HTMLElement).style;
  expect(bounds('top').width).toBe('calc(100% - 0px)');
  expect(bounds('top').height).toBe('calc(50% - 1px)');
  expect(bounds('left').width).toBe('calc(50% - 1px)');
  expect(bounds('right').left).toBe('50%');
  expect(bounds('right').width).toBe('calc(50% - 0px)');
  expect(bounds('left').height).toBe('calc(50% - 0px)');
  expect(screen.getAllByRole('separator')).toHaveLength(2);
  view.rerender(<WorkspacePaneLayout {...props} maximized='left' />);
  expect(bounds('left').width).toBe('calc(100% - 0px)');
  expect(bounds('left').height).toBe('calc(100% - 0px)');
  expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  view.rerender(<WorkspacePaneLayout {...props} layout={pane('left')} />);
  expect(bounds('left').width).toBe('calc(100% - 0px)');
  expect(bounds('left').height).toBe('calc(100% - 0px)');
});
