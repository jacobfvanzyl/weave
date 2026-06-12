import { generateName } from '@criblinc/docker-names';
import type { WorkspaceBranchMode } from './chat-state-api';

export type WorkspaceCreateDraft = {
  name: string;
  mode: WorkspaceBranchMode;
  branch: string;
  base: string;
};

export const getDefaultWorkspaceBase = (defaultBranch?: string) => defaultBranch?.trim() || 'main';

export const createWorkspaceDraftDefaults = (defaultBranch?: string): WorkspaceCreateDraft => ({
  name: generateName(),
  mode: 'detached',
  branch: '',
  base: getDefaultWorkspaceBase(defaultBranch),
});
