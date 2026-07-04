import {
  createProject,
  deleteProject,
  listProductProjects,
  reorderProjects,
  type CreateProjectInput,
} from './chat-state-api';

export const listCodeProjects = () => listProductProjects('code');

export const createCodeProject = (input: CreateProjectInput) =>
  createProject({ ...input, projectKind: 'git' });

export const deleteCodeProject = (projectId: string) => deleteProject(projectId, 'git');

export const reorderCodeProjects = (projectIds: string[]) => reorderProjects(projectIds, 'code');
