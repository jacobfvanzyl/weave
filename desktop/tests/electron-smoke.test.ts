import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, type ElectronApplication } from '@playwright/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const runSmoke = process.env.WEAVE_ELECTRON_SMOKE === '1';
const testDirectory = path.dirname(fileURLToPath(import.meta.url));

describe.skipIf(!runSmoke)('Weave Electron smoke', () => {
  let app: ElectronApplication | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let serverUrl = '';
  let userDataPath = '';

  beforeEach(async () => {
    server = createServer((request, response) => {
      if (request.url === '/chat-state/me') {
        if (request.headers.authorization === 'Bearer test-token') {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ user: { id: 'smoke-user', name: 'Smoke User' } }));
          return;
        }

        response.statusCode = 401;
        response.end('unauthorized');
        return;
      }

      if (request.url === '/models') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ defaultModel: 'openai/gpt-5.5', options: [] }));
        return;
      }

      if (request.url === '/planes') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ planes: [] }));
        return;
      }

      response.statusCode = 404;
      response.end('not found');
    });

    await new Promise<void>(resolve => {
      server?.listen(0, '127.0.0.1', () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Smoke server did not start.');
    serverUrl = `http://127.0.0.1:${address.port}`;
    userDataPath = mkdtempSync(path.join(tmpdir(), 'weave-smoke-'));
  });

  afterEach(async () => {
    await app?.close();
    await new Promise<void>(resolve => server?.close(() => resolve()));
    rmSync(userDataPath, { recursive: true, force: true });
  });

  it('exercises failed auth, saved auth, chat shell render, and no renderer Node API', async () => {
    app = await electron.launch({
      args: [path.resolve(testDirectory, '../.vite/build/main.js')],
      env: {
        ...process.env,
        WEAVE_DESKTOP_SERVER_URL: serverUrl,
        WEAVE_DESKTOP_USER_DATA: userDataPath,
        WEAVE_AUTH_TOKEN: '',
      },
    });

    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.getByText(/unauthorized/i).waitFor();

    await page.getByLabel('Auth token').fill('test-token');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByLabel('Connection settings').waitFor();
    expect(
      await page.getByRole('button', { name: 'Hide sidebar' }).evaluate(element =>
        getComputedStyle(element).getPropertyValue('-webkit-app-region'),
      ),
    ).toBe('no-drag');
    expect(
      await page.getByRole('button', { name: 'Hide sidebar' }).locator('svg').evaluate(element =>
        getComputedStyle(element).getPropertyValue('-webkit-app-region'),
      ),
    ).toBe('no-drag');
    await page.getByRole('button', { name: 'Hide sidebar' }).click();
    await page.getByRole('button', { name: 'Show sidebar' }).waitFor();

    expect(await page.evaluate(() => typeof window.require)).toBe('undefined');
    expect(await page.locator('body').evaluate(element => getComputedStyle(element).colorScheme)).toBe('dark');
  }, 15_000);
});
