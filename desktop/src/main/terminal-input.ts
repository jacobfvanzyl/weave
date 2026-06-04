import type { TerminalSessionKind, TerminalStartInput } from '../shared/terminal';

type NormalizedTerminalStartInput = TerminalStartInput & {
  cols: number;
  rows: number;
};

const parseIdentifier = (value: unknown, name: string) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
};

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const parseDimension = (value: unknown, fallback: number, min: number, max: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
};

export const parseTerminalStartInput = (input: unknown): NormalizedTerminalStartInput => {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const isGeneralTerminalRequest = record.kind === 'general'
    || (
      record.kind !== 'workspace'
      && record.projectId === undefined
      && record.workspaceId === undefined
      && (record.terminalId === 'weave-general-terminal' || typeof record.cwd === 'string')
    );
  const kind: TerminalSessionKind = isGeneralTerminalRequest ? 'general' : 'workspace';
  const parsedDimensions = {
    cols: parseDimension(record.cols, 80, 10, 400),
    rows: parseDimension(record.rows, 24, 3, 200),
  };
  const common = {
    portalId: optionalString(record.portalId),
    rootId: optionalString(record.rootId),
    repoPath: optionalString(record.repoPath),
    workspacePath: optionalString(record.workspacePath),
    cwd: optionalString(record.cwd),
    ...parsedDimensions,
  };

  if (kind === 'general') {
    return {
      kind,
      terminalId: parseIdentifier(record.terminalId ?? 'weave-general-terminal', 'terminalId'),
      ...common,
    };
  }

  const workspaceId = parseIdentifier(record.workspaceId, 'workspaceId');
  return {
    kind,
    terminalId: parseIdentifier(record.terminalId ?? workspaceId, 'terminalId'),
    projectId: parseIdentifier(record.projectId, 'projectId'),
    workspaceId,
    ...common,
  };
};

export const parseTerminalId = (value: unknown) => parseIdentifier(value, 'terminalId');

export const parseTerminalInputData = (value: unknown) => {
  if (typeof value !== 'string') throw new Error('terminal input data must be a string.');
  return value;
};

export const parseTerminalResize = (cols: unknown, rows: unknown) => ({
  cols: parseDimension(cols, 80, 10, 400),
  rows: parseDimension(rows, 24, 3, 200),
});
