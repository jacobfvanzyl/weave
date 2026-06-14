import { getAuthHeaders, getMastraUrl } from './mastra-client';
import type { EditorTarget } from './editor-types';

export type VaultTarget = EditorTarget;

export type VaultEntry = {
  name: string;
  path: string;
  type: 'directory' | 'file' | 'other';
  hidden?: boolean;
  size?: number;
  mtimeMs?: number;
};

export type VaultNote = {
  path: string;
  title: string;
  headings: string[];
  tags: string[];
  links: string[];
  embeds: string[];
  properties: Record<string, string>;
  mtimeMs?: number;
  size?: number;
  preview?: string;
};

export type VaultAttachment = {
  path: string;
  name: string;
  mediaType: 'image' | 'audio' | 'video' | 'pdf' | 'excalidraw' | 'other';
  size?: number;
  mtimeMs?: number;
};

export type VaultIndexResult = {
  path: string;
  entries: VaultEntry[];
  notes: VaultNote[];
  attachments: VaultAttachment[];
  backlinks: Record<string, string[]>;
  checkedAt: string;
};

export type VaultFile = {
  path: string;
  content: string;
  version: string;
  size?: number;
  mtimeMs?: number;
};

export type VaultWriteResult = {
  path: string;
  version: string;
  size?: number;
  mtimeMs?: number;
};

export type VaultBackend = {
  index: (target: VaultTarget, path?: string) => Promise<VaultIndexResult>;
  read: (target: VaultTarget, path: string) => Promise<VaultFile>;
  write: (target: VaultTarget, path: string, content: string, version?: string) => Promise<VaultWriteResult>;
  mkdir: (target: VaultTarget, path: string) => Promise<{ ok: true; path?: string }>;
  move: (target: VaultTarget, fromPath: string, toPath: string, overwrite?: boolean) => Promise<{ ok: true; path?: string }>;
  delete: (target: VaultTarget, path: string, recursive?: boolean) => Promise<{ ok: true; path?: string }>;
  upload: (target: VaultTarget, path: string, base64Content: string, contentType?: string) => Promise<{ ok: true; path?: string }>;
};

const request = async <T>(action: 'index' | 'read' | 'write' | 'mkdir' | 'move' | 'delete' | 'upload', body: unknown): Promise<T> => {
  const response = await fetch(`${getMastraUrl()}/vault/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text
    ? (() => {
        try {
          return JSON.parse(text) as { error?: string } & T;
        } catch {
          return undefined;
        }
      })()
    : undefined;
  if (!response.ok) throw new Error(parsed?.error || text || `Vault request failed: HTTP ${response.status}`);
  if (!parsed) throw new Error('Vault response was empty.');
  return parsed;
};

export const createVaultBackend = (): VaultBackend => ({
  index: (target, path) => request<VaultIndexResult>('index', { target, path }),
  read: (target, path) => request<VaultFile>('read', { target, path }),
  write: (target, path, content, version) => request<VaultWriteResult>('write', { target, path, content, version }),
  mkdir: (target, path) => request<{ ok: true; path?: string }>('mkdir', { target, path }),
  move: (target, fromPath, toPath, overwrite) => request<{ ok: true; path?: string }>('move', { target, fromPath, toPath, overwrite }),
  delete: (target, path, recursive) => request<{ ok: true; path?: string }>('delete', { target, path, recursive }),
  upload: (target, path, base64Content, contentType) => request<{ ok: true; path?: string }>('upload', { target, path, base64Content, contentType }),
});
