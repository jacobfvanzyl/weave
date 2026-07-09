import { objectNotesVaultBackend } from './object-backend';
import { portalNotesVaultBackend } from './portal-backend';
import type { NotesVaultBackend } from './types';

const backends = new Map<string, NotesVaultBackend>();

export const registerNotesVaultBackend = (backend: NotesVaultBackend) => {
  if (!backend.kind.trim()) throw new Error('Notes vault backend kind is required.');
  backends.set(backend.kind, backend);
};

export const getNotesVaultBackend = (kind: string) => backends.get(kind);

export const listNotesVaultBackendKinds = () => [...backends.keys()].sort();

registerNotesVaultBackend(portalNotesVaultBackend);
registerNotesVaultBackend(objectNotesVaultBackend);
