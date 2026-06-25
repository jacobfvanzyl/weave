import type { ResultSet } from '@libsql/client';
import { getWeaveDb } from '../storage/weave-db';
import type { ProductId, Project } from './types';
import { productForProject } from './types';

type ProjectRow = {
  owner_id: string;
  product: ProductId;
  project_id: string;
  project_kind: Project['projectKind'];
  name: string;
  sort_order?: number | null;
  created_at: string;
  updated_at: string;
  data: string;
};

export type ListProjectsOptions = {
  product?: ProductId;
  includeHidden?: boolean;
};

const toProjectRow = (row: ResultSet['rows'][number]) => row as unknown as ProjectRow;

const parseProject = (row: ResultSet['rows'][number]): Project => {
  const projectRow = toProjectRow(row);
  return JSON.parse(String(projectRow.data)) as Project;
};

const visibleProject = (project: Project) => !project.hidden && project.systemKind !== 'adHoc';

export class ProductProjectRepository {
  private migratedOwners = new Set<string>();

  async save(project: Project) {
    const db = await getWeaveDb();
    const product = productForProject(project);
    await db.batch([
      {
        sql: `DELETE FROM weave_product_projects
          WHERE owner_id = ? AND project_id = ? AND product <> ?`,
        args: [project.userId, project.id, product],
      },
      {
        sql: `INSERT INTO weave_product_projects (
            owner_id, product, project_id, project_kind, name, sort_order, created_at, updated_at, data
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(owner_id, product, project_id) DO UPDATE SET
            project_kind = excluded.project_kind,
            name = excluded.name,
            sort_order = excluded.sort_order,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            data = excluded.data`,
        args: [
          project.userId,
          product,
          project.id,
          project.projectKind,
          project.name,
          project.sortOrder ?? null,
          project.createdAt,
          project.updatedAt,
          JSON.stringify(project),
        ],
      },
    ], 'write');
    return project;
  }

  async get(ownerId: string, projectId: string, product?: ProductId) {
    const db = await getWeaveDb();
    const result = await db.execute({
      sql: product
        ? `SELECT * FROM weave_product_projects WHERE owner_id = ? AND product = ? AND project_id = ? LIMIT 1`
        : `SELECT * FROM weave_product_projects WHERE owner_id = ? AND project_id = ? LIMIT 1`,
      args: product ? [ownerId, product, projectId] : [ownerId, projectId],
    });
    const row = result.rows[0];
    return row ? parseProject(row) : undefined;
  }

  async list(ownerId: string, options: ListProjectsOptions = {}) {
    const db = await getWeaveDb();
    const result = await db.execute({
      sql: options.product
        ? `SELECT * FROM weave_product_projects WHERE owner_id = ? AND product = ?`
        : `SELECT * FROM weave_product_projects WHERE owner_id = ?`,
      args: options.product ? [ownerId, options.product] : [ownerId],
    });
    return result.rows
      .map(parseProject)
      .filter(project => options.includeHidden === true || visibleProject(project))
      .sort((a, b) =>
        (a.sortOrder ?? Number.MAX_SAFE_INTEGER) - (b.sortOrder ?? Number.MAX_SAFE_INTEGER)
        || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async delete(ownerId: string, projectId: string) {
    const db = await getWeaveDb();
    await db.execute({
      sql: `DELETE FROM weave_product_projects WHERE owner_id = ? AND project_id = ?`,
      args: [ownerId, projectId],
    });
  }

  async reorder(ownerId: string, product: ProductId, projectIds: string[]) {
    const projects = await this.list(ownerId, { product });
    const byId = new Map(projects.map(project => [project.id, project]));
    if (projectIds.length !== byId.size || projectIds.some(id => !byId.has(id))) {
      throw new Error('projectIds must include all visible projects for this product');
    }

    const now = new Date().toISOString();
    await Promise.all(projectIds.map((projectId, index) => {
      const project = byId.get(projectId)!;
      return this.save({ ...project, sortOrder: index, updatedAt: now });
    }));
  }

  async migrateLegacyProjects(
    ownerId: string,
    loadLegacyProjects: () => Promise<Project[]>,
  ) {
    if (this.migratedOwners.has(ownerId)) return;
    const existing = await this.list(ownerId, { includeHidden: true });
    if (existing.length > 0) {
      this.migratedOwners.add(ownerId);
      return;
    }

    const legacyProjects = await loadLegacyProjects();
    await Promise.all(legacyProjects.map(project => this.save(project)));
    this.migratedOwners.add(ownerId);
  }

  resetOwnerMigrationForTest(ownerId: string) {
    this.migratedOwners.delete(ownerId);
  }
}

export const productProjectRepository = new ProductProjectRepository();

class ProductRepository {
  constructor(private readonly product: ProductId) {}

  save(project: Project) {
    return productProjectRepository.save(project);
  }

  get(ownerId: string, projectId: string) {
    return productProjectRepository.get(ownerId, projectId, this.product);
  }

  list(ownerId: string, options: Omit<ListProjectsOptions, 'product'> = {}) {
    return productProjectRepository.list(ownerId, { ...options, product: this.product });
  }

  delete(ownerId: string, projectId: string) {
    return productProjectRepository.delete(ownerId, projectId);
  }

  reorder(ownerId: string, projectIds: string[]) {
    return productProjectRepository.reorder(ownerId, this.product, projectIds);
  }
}

export class CodeRepository extends ProductRepository {
  constructor() {
    super('code');
  }
}

export class NotesRepository extends ProductRepository {
  constructor() {
    super('notes');
  }
}

export class ChatRepository extends ProductRepository {
  constructor() {
    super('chat');
  }
}

export const codeRepository = new CodeRepository();
export const notesRepository = new NotesRepository();
export const chatRepository = new ChatRepository();
