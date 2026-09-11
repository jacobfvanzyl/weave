import { expect, it } from 'vitest';
import { workspaceDirectories } from './workspace-directories';
import type { TerminalSummary, Workspace } from '@weave/product-protocol';
const workspace: Workspace = { workspaceId: 'workspace', name: 'Build', layout: { kind: 'split', nodeId: 'split', axis: 'horizontal', ratio: 0.5, children: [
  { kind: 'terminal', nodeId: 'a', paneId: 'pa', terminalId: 'ta', executionContextId: 'first' },
  { kind: 'terminal', nodeId: 'b', paneId: 'pb', terminalId: 'tb', executionContextId: 'second' },
] } };
it('deduplicates complete paths in pane order without interpreting titles or merging Workspaces', () => {
  const records = [{ terminalId: 'tb', currentDirectory: '/other/Keyphase/odin' }, { terminalId: 'ta', currentDirectory: '/Users/jaco/Keyphase/odin' }] as TerminalSummary[];
  expect(workspaceDirectories(workspace, records)).toEqual(['/Users/jaco/Keyphase/odin', '/other/Keyphase/odin']);
  expect(workspaceDirectories({ ...workspace, workspaceId: 'independent' }, records)).toEqual(workspaceDirectories(workspace, records));
  records[0]!.currentDirectory = records[1]!.currentDirectory;
  expect(workspaceDirectories(workspace, records)).toEqual(['/Users/jaco/Keyphase/odin']);
  delete records[0]!.currentDirectory; delete records[1]!.currentDirectory;
  records[0]!.title = '/not/a/directory/observation';
  expect(workspaceDirectories(workspace, records)).toEqual([]);
  expect(workspaceDirectories({ ...workspace, layout: null }, records)).toEqual([]);
});
