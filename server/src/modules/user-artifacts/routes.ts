import type { Context } from 'hono';
import { getOwner } from '../../owner/auth';
import { defineRoute, mountRoute } from '../../server/routes';
import type { ServerVariables } from '../../server/types';
import type { ServerModule } from '../types';
import {
  type UserArtifactRecord,
  type UserArtifactRepository,
  userArtifactRepository,
  type UserPromptDocument,
  type UserSkillDocument,
  type UserSkillFile,
} from './repository';

type UserArtifactRouteContext = Context<{ Variables: ServerVariables }>;

const parseJsonBody = async (c: UserArtifactRouteContext) => {
  const body = await c.req.json().catch(() => undefined);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  return body as Record<string, unknown>;
};

const optionalString = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

const parseContentBody = async (c: UserArtifactRouteContext) => {
  const body = await parseJsonBody(c);
  const content = typeof body.content === 'string' ? body.content : undefined;
  if (content === undefined) throw new Error('Request body must include string content.');
  return content;
};

const artifactSummaryResponse = (record: UserArtifactRecord) => ({
  kind: record.kind,
  name: record.name,
  objectKey: record.objectKey,
  objectPrefix: record.objectPrefix,
  contentHash: record.contentHash,
  sizeBytes: record.sizeBytes,
  metadata: record.metadata,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

const promptResponse = (prompt: UserPromptDocument) => ({
  ...artifactSummaryResponse(prompt),
  content: prompt.content,
});

const skillFileResponse = (file: UserSkillFile) => ({
  path: file.path,
  objectKey: file.objectKey,
  sizeBytes: file.sizeBytes,
  updatedAt: file.updatedAt,
  ...(file.content !== undefined ? { content: file.content } : {}),
});

const skillResponse = (skill: UserSkillDocument) => ({
  ...artifactSummaryResponse(skill),
  files: skill.files.map(skillFileResponse),
  ...(skill.entrypoint !== undefined ? { entrypoint: skill.entrypoint } : {}),
});

const errorResponse = (c: UserArtifactRouteContext, error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const status = /not found/i.test(message) ? 404 : /must|required|cannot|invalid/i.test(message) ? 400 : 500;
  return c.json({ error: message }, status as never);
};

export const createUserArtifactRoutes = (repository: UserArtifactRepository = userArtifactRepository) => [
  defineRoute('/user-artifacts/prompts', {
    method: 'GET',
    handler: async (c) => {
      const owner = getOwner(c);
      const prompts = await repository.listPrompts(owner.id);
      return c.json({ prompts: prompts.map(artifactSummaryResponse) });
    },
  }),
  defineRoute('/user-artifacts/prompts/:name', {
    method: 'GET',
    handler: async (c) => {
      const owner = getOwner(c);
      const prompt = await repository.getPrompt(owner.id, c.req.param('name'));
      if (!prompt) return c.json({ error: 'Prompt was not found.' }, 404);
      return c.json({ prompt: promptResponse(prompt) });
    },
  }),
  defineRoute('/user-artifacts/prompts/:name', {
    method: 'PUT',
    handler: async (c) => {
      const owner = getOwner(c);
      try {
        const prompt = await repository.putPrompt({
          ownerId: owner.id,
          name: c.req.param('name'),
          content: await parseContentBody(c),
        });
        return c.json({ prompt: artifactSummaryResponse(prompt) });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/user-artifacts/prompts/:name', {
    method: 'DELETE',
    handler: async (c) => {
      const owner = getOwner(c);
      await repository.deletePrompt(owner.id, c.req.param('name'));
      return c.body(null, 204);
    },
  }),
  defineRoute('/user-artifacts/skills', {
    method: 'GET',
    handler: async (c) => {
      const owner = getOwner(c);
      const skills = await repository.listSkills(owner.id);
      return c.json({ skills: skills.map(artifactSummaryResponse) });
    },
  }),
  defineRoute('/user-artifacts/skills/:name', {
    method: 'GET',
    handler: async (c) => {
      const owner = getOwner(c);
      const skill = await repository.getSkill(owner.id, c.req.param('name'));
      if (!skill) return c.json({ error: 'Skill was not found.' }, 404);
      return c.json({ skill: skillResponse(skill) });
    },
  }),
  defineRoute('/user-artifacts/skills/:name', {
    method: 'PUT',
    handler: async (c) => {
      const owner = getOwner(c);
      try {
        const skill = await repository.putSkill({
          ownerId: owner.id,
          name: c.req.param('name'),
          content: await parseContentBody(c),
        });
        return c.json({ skill: artifactSummaryResponse(skill) });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/user-artifacts/skills/:name', {
    method: 'DELETE',
    handler: async (c) => {
      const owner = getOwner(c);
      await repository.deleteSkill(owner.id, c.req.param('name'));
      return c.body(null, 204);
    },
  }),
  defineRoute('/user-artifacts/skills/:name/files', {
    method: 'GET',
    handler: async (c) => {
      const owner = getOwner(c);
      const path = optionalString(c.req.query('path'));
      if (!path) return c.json({ error: 'Query parameter path is required.' }, 400);
      try {
        const file = await repository.getSkillFile(owner.id, c.req.param('name'), path);
        if (!file) return c.json({ error: 'Skill file was not found.' }, 404);
        return c.json({ file: skillFileResponse(file) });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/user-artifacts/skills/:name/files', {
    method: 'PUT',
    handler: async (c) => {
      const owner = getOwner(c);
      const path = optionalString(c.req.query('path'));
      if (!path) return c.json({ error: 'Query parameter path is required.' }, 400);
      try {
        const skill = await repository.putSkillFile({
          ownerId: owner.id,
          name: c.req.param('name'),
          path,
          content: await parseContentBody(c),
        });
        return c.json({ skill: artifactSummaryResponse(skill) });
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
  defineRoute('/user-artifacts/skills/:name/files', {
    method: 'DELETE',
    handler: async (c) => {
      const owner = getOwner(c);
      const path = optionalString(c.req.query('path'));
      if (!path) return c.json({ error: 'Query parameter path is required.' }, 400);
      try {
        await repository.deleteSkillFile(owner.id, c.req.param('name'), path);
        return c.body(null, 204);
      } catch (error) {
        return errorResponse(c, error);
      }
    },
  }),
];

export const userArtifactRoutes = createUserArtifactRoutes();

export const userArtifactsModule: ServerModule = {
  id: 'user-artifacts',
  registerRoutes: (app) => {
    for (const route of userArtifactRoutes) mountRoute(app, route);
  },
};
