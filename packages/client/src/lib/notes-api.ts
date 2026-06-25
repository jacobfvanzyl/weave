import {
  createProject,
  deleteProject,
  listProductProjects,
  reorderProjects,
  setProjectProfile,
  type CreateProjectInput,
} from './chat-state-api';

export const listNotesProjects = () => listProductProjects('notes');

export const createNotesProject = (input: CreateProjectInput) =>
  createProject({ ...input, projectKind: 'notes' });

export const deleteNotesProject = (projectId: string) => deleteProject(projectId, 'notes');

export const reorderNotesProjects = (projectIds: string[]) => reorderProjects(projectIds, 'notes');

export const setNotesProjectProfile = (projectId: string, profileId: string | null) =>
  setProjectProfile(projectId, profileId, 'notes');
