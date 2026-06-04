import path from 'node:path';
import type { EditorListInput, EditorReadInput, EditorTarget, EditorWriteInput } from '../shared/editor';

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object');

const parseIdentifier = (value: unknown, name: string) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
};

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

export const parseEditorPath = (value: unknown, name = 'path') => {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
  if (value.includes('\0')) throw new Error(`${name} cannot contain null bytes.`);

  const normalizedInput = value.trim().replace(/\\/g, '/');
  if (!normalizedInput || normalizedInput === '.') return '';
  if (path.posix.isAbsolute(normalizedInput) || /^[a-zA-Z]:\//.test(normalizedInput)) {
    throw new Error(`${name} must be relative to the workspace root.`);
  }

  const normalized = path.posix.normalize(normalizedInput);
  if (normalized === '.' || normalized === '') return '';
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`${name} cannot escape the workspace root.`);
  }

  return normalized.replace(/^\.\//, '');
};

export const parseEditorTarget = (value: unknown): EditorTarget => {
  if (!isRecord(value)) throw new Error('target is required.');
  return {
    projectId: parseIdentifier(value.projectId, 'projectId'),
    workspaceId: parseIdentifier(value.workspaceId, 'workspaceId'),
    portalId: optionalString(value.portalId),
    rootId: optionalString(value.rootId),
    repoPath: optionalString(value.repoPath),
    workspacePath: optionalString(value.workspacePath),
  };
};

export const parseEditorListInput = (input: unknown): EditorListInput => {
  if (!isRecord(input)) throw new Error('editor list input is required.');
  return {
    target: parseEditorTarget(input.target),
    path: parseEditorPath(input.path),
  };
};

export const parseEditorReadInput = (input: unknown): EditorReadInput => {
  if (!isRecord(input)) throw new Error('editor read input is required.');
  return {
    target: parseEditorTarget(input.target),
    path: parseEditorPath(input.path),
  };
};

export const parseEditorWriteInput = (input: unknown): EditorWriteInput => {
  if (!isRecord(input)) throw new Error('editor write input is required.');
  if (typeof input.content !== 'string') throw new Error('content must be a string.');
  if (input.version !== undefined && typeof input.version !== 'string') throw new Error('version must be a string.');

  return {
    target: parseEditorTarget(input.target),
    path: parseEditorPath(input.path),
    content: input.content,
    version: input.version,
  };
};
