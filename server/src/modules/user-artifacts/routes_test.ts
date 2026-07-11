import { Hono } from 'hono';
import { createOwnerAuthMiddleware } from '../../owner/auth.ts';
import { mountRoute } from '../../server/routes.ts';
import type { ServerVariables, WeaveApp } from '../../server/types.ts';
import { createUserArtifactRoutes } from './routes.ts';
import type { UserArtifactRecord, UserArtifactRepository } from './repository.ts';

const assertEquals = (actual: unknown, expected: unknown, message?: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message ?? `Expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
  }
};

const record = (kind: 'prompt' | 'skill', name: string, overrides: Partial<UserArtifactRecord> = {}) => ({
  ownerId: 'owner-1',
  kind,
  name,
  objectBucket: 'weave',
  objectKey: kind === 'prompt' ? `users/owner-1/prompts/${name}.md` : `users/owner-1/skills/${name}/SKILL.md`,
  objectPrefix: kind === 'skill' ? `users/owner-1/skills/${name}` : undefined,
  contentHash: 'hash',
  sizeBytes: 10,
  metadata: {},
  createdAt: '2026-07-09T00:00:00.000Z',
  updatedAt: '2026-07-09T00:00:00.000Z',
  ...overrides,
} satisfies UserArtifactRecord);

const createTestApp = (repository: UserArtifactRepository) => {
  const app = new Hono<{ Variables: ServerVariables }>();
  app.use(
    '*',
    createOwnerAuthMiddleware({
      auth: {
        token: 'test-token',
        owner: { id: 'owner-1', name: 'Test Owner', role: 'owner' },
      },
      mastra: {} as ServerVariables['mastra'],
    }),
  );
  for (const route of createUserArtifactRoutes(repository)) mountRoute(app as WeaveApp, route);
  return app;
};

Deno.test('user artifact routes require owner auth', async () => {
  const app = createTestApp({ listPrompts: () => Promise.resolve([]) } as unknown as UserArtifactRepository);

  const response = await app.request('/user-artifacts/prompts');

  assertEquals(response.status, 401);
});

Deno.test('user artifact routes write prompt Markdown for the authenticated owner', async () => {
  let putInput: Record<string, unknown> | undefined;
  const repository = {
    listPrompts: () => Promise.resolve([record('prompt', 'ship')]),
    putPrompt: (input: Record<string, unknown>) => {
      putInput = input;
      return Promise.resolve(record('prompt', String(input.name), { sizeBytes: String(input.content).length }));
    },
  } as unknown as UserArtifactRepository;
  const app = createTestApp(repository);

  const putResponse = await app.request('/user-artifacts/prompts/ship', {
    method: 'PUT',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ content: '# Ship\n' }),
  });
  const putJson = await putResponse.json();
  const listResponse = await app.request('/user-artifacts/prompts', {
    headers: { authorization: 'Bearer test-token' },
  });
  const listJson = await listResponse.json();

  assertEquals(putResponse.status, 200);
  assertEquals(putInput, { ownerId: 'owner-1', name: 'ship', content: '# Ship\n' });
  assertEquals(putJson.prompt.objectKey, 'users/owner-1/prompts/ship.md');
  assertEquals(listResponse.status, 200);
  assertEquals(listJson.prompts.map((item: { name: string }) => item.name), ['ship']);
});

Deno.test('user artifact routes write skill files for the authenticated owner', async () => {
  let putInput: Record<string, unknown> | undefined;
  const repository = {
    putSkillFile: (input: Record<string, unknown>) => {
      putInput = input;
      return Promise.resolve(record('skill', String(input.name)));
    },
  } as unknown as UserArtifactRepository;
  const app = createTestApp(repository);

  const response = await app.request('/user-artifacts/skills/release/files?path=references%2Fnotes.md', {
    method: 'PUT',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ content: '# Notes\n' }),
  });
  const json = await response.json();

  assertEquals(response.status, 200);
  assertEquals(putInput, {
    ownerId: 'owner-1',
    name: 'release',
    path: 'references/notes.md',
    content: '# Notes\n',
  });
  assertEquals(json.skill.objectPrefix, 'users/owner-1/skills/release');
});
