import { expect, test } from 'bun:test';
import { parsePortalRpcParams, parsePortalRpcResult, type Workspace } from './index';

const tab = (): Workspace => ({ workspaceId: 'tab', name: 'Build', layout: { kind: 'terminal', executionContextId: 'workspace', nodeId: 'node', paneId: 'pane', terminalId: 'terminal' } });

test('composition RPC round trips stable identities and ordered split layouts', () => {
  const first = tab();
  first.layout = { kind: 'split', nodeId: 'split', axis: 'horizontal', ratio: 0.6, children: [first.layout!, { kind: 'terminal', executionContextId: 'workspace', nodeId: 'node2', paneId: 'pane2', terminalId: null }] };
  const params = { hostId: 'host', expectedRevision: 4, workspaces: [first] };
  expect(parsePortalRpcParams('workspace.composition.replace', params)).toEqual(params);
  const result = { composition: { schemaVersion: 2, hostId: 'host', revision: 5, workspaces: [first] } };
  expect(parsePortalRpcResult('workspace.composition.get', result)).toEqual(result);
  expect(() => parsePortalRpcResult('workspace.composition.get', { composition: { ...result.composition, schemaVersion: 99 } })).toThrow('Unsupported');
});

test('composition boundary rejects ambiguous identities and unbounded or malformed layouts', () => {
  const parse = (tabs: unknown, expectedRevision: unknown = 0) => parsePortalRpcParams('workspace.composition.replace', { hostId: 'host', expectedRevision, workspaces: tabs });
  expect(() => parse([tab(), tab()])).toThrow('Duplicate');
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER, '1']) expect(() => parse([], value)).toThrow('revision');
  for (const ratio of [0, 1, NaN]) expect(() => parse([{ ...tab(), layout: { kind: 'split', nodeId: 'split', axis: 'horizontal', ratio, children: [tab().layout!, tab().layout] } }])).toThrow('split');
  expect(() => parse([{ ...tab(), layout: { ...tab().layout, terminalId: undefined } }])).toThrow('identity');
  let node: unknown = tab().layout;
  for (let i = 0; i < 10; i++) node = { kind: 'split', nodeId: `split${i}`, axis: 'vertical', ratio: 0.5, children: [node, { kind: 'terminal', executionContextId: 'workspace', nodeId: `node${i}`, paneId: `pane${i}`, terminalId: null }] };
  expect(() => parse([{ ...tab(), layout: node }])).toThrow('deep');
});

test('a terminal can occur only once across all panes and tabs of a workspace', () => {
  const second = { workspaceId: 'tab2', name: 'Other', layout: { kind: 'terminal' as const, executionContextId: 'workspace', nodeId: 'node2', paneId: 'pane2', terminalId: 'terminal' } };
  const parse = (tabs: Workspace[]) => parsePortalRpcParams('workspace.composition.replace', { hostId: 'host', expectedRevision: 0, workspaces: tabs });
  expect(() => parse([tab(), second])).toThrow('only appear once');
  expect(() => parse([{ ...tab(), layout: { kind: 'split', nodeId: 'split', axis: 'vertical', ratio: 0.5, children: [tab().layout!, second.layout] } }])).toThrow('only appear once');
  expect(() => parse([tab(), { ...second, layout: { ...second.layout, terminalId: 'different' } }])).not.toThrow();
});
