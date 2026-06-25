import type { Project } from './chat-state-api';

export type ProductId = 'code' | 'notes' | 'chat';

export const productLabels: Record<ProductId, string> = {
  code: 'Code',
  notes: 'Notes',
  chat: 'Chat',
};

export const productForProjectKind = (projectKind: Project['projectKind']): ProductId =>
  projectKind === 'notes' ? 'notes' : projectKind === 'general' ? 'chat' : 'code';

export const projectKindForProduct = (product: ProductId): Project['projectKind'] =>
  product === 'notes' ? 'notes' : product === 'chat' ? 'general' : 'git';

export const projectBelongsToProduct = (project: Pick<Project, 'projectKind'>, product: ProductId) =>
  productForProjectKind(project.projectKind) === product;
