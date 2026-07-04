import {
  createProject,
  deleteProject,
  listProductProjects,
  reorderProjects,
  type CreateProjectInput,
} from './chat-state-api';

export const listChatProjects = () => listProductProjects('chat');

export const createChatProject = (input: CreateProjectInput) =>
  createProject({ ...input, projectKind: 'general' });

export const deleteChatProject = (projectId: string) => deleteProject(projectId, 'general');

export const reorderChatProjects = (projectIds: string[]) => reorderProjects(projectIds, 'chat');
