import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect as playwrightExpect, type ElectronApplication } from '@playwright/test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const runSmoke = process.env.WEAVE_ELECTRON_SMOKE === '1';
const smokeClientApp = process.env.WEAVE_ELECTRON_SMOKE_APP === 'coppermind' ? 'coppermind' : 'flare';
const testDirectory = path.dirname(fileURLToPath(import.meta.url));

describe.skipIf(!runSmoke)('Weave Electron smoke', () => {
  let app: ElectronApplication | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let serverUrl = '';
  let userDataPath = '';

  beforeEach(async () => {
    const now = new Date().toISOString();
    const codeProject = {
      id: 'project-1',
      userId: 'smoke-user',
      name: 'Smoke Code',
      projectKind: 'git',
      portalId: 'smoke-portal',
      portalRootId: 'default',
      repoPath: '/tmp/smoke',
      sortOrder: 0,
      workspaces: [{
        id: 'workspace-1',
        projectId: 'project-1',
        portalId: 'smoke-portal',
        workspaceKind: 'primary',
        source: 'primary',
        name: 'main',
        path: '/tmp/smoke',
        status: 'ready',
        locked: true,
        createdAt: now,
        updatedAt: now,
      }],
      createdAt: now,
      updatedAt: now,
    };
    const notesProject = {
      id: 'notes-project',
      userId: 'smoke-user',
      name: 'Smoke Notes',
      projectKind: 'notes',
      portalId: 'smoke-portal',
      portalRootId: 'default',
      vaultPath: '/tmp/notes',
      notesStorage: { kind: 'portal', portalId: 'smoke-portal', rootId: 'default', vaultPath: '/tmp/notes' },
      sortOrder: 1,
      workspaces: [{
        id: 'notes-workspace',
        projectId: 'notes-project',
        portalId: 'smoke-portal',
        workspaceKind: 'primary',
        source: 'primary',
        name: 'Vault',
        path: '/tmp/notes',
        status: 'ready',
        locked: true,
        createdAt: now,
        updatedAt: now,
      }],
      createdAt: now,
      updatedAt: now,
    };
    const generalProject = {
      id: 'general-project',
      userId: 'smoke-user',
      name: 'Smoke Threads',
      projectKind: 'general',
      sortOrder: 2,
      workspaces: [],
      createdAt: now,
      updatedAt: now,
    };
    const allProjects = [codeProject, notesProject, generalProject];
    const smokeThreads = [{
      id: 'plain-thread',
      title: 'Loose thought',
      createdAt: now,
      updatedAt: now,
      metadata: { sortOrder: 0 },
    }, {
      id: 'general-thread',
      title: 'General project thread',
      createdAt: now,
      updatedAt: now,
      metadata: { mode: 'project', projectId: 'general-project', sortOrder: 0 },
    }, {
      id: 'notes-thread',
      title: 'Notes project thread',
      createdAt: now,
      updatedAt: now,
      metadata: { mode: 'project', projectId: 'notes-project', workspaceId: 'notes-workspace', sortOrder: 0 },
    }];
    server = createServer((request, response) => {
      response.setHeader('access-control-allow-origin', '*');
      response.setHeader('access-control-allow-headers', 'authorization, content-type');
      if (request.method === 'OPTIONS') {
        response.statusCode = 204;
        response.end();
        return;
      }

      if (request.url === '/owner/me' || request.url === '/chat-state/me') {
        if (request.headers.authorization === 'Bearer test-token') {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({
            owner: { id: 'smoke-user', name: 'Smoke User' },
            user: { id: 'smoke-user', name: 'Smoke User' },
          }));
          return;
        }

        response.statusCode = 401;
        response.end('unauthorized');
        return;
      }

      if (request.url === '/agent/models' || request.url === '/models') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ defaultModel: 'openai/gpt-5.5', options: [] }));
        return;
      }

      if (request.url === '/agent/chatgpt/auth-status' || request.url === '/chatgpt/auth-status') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ connected: true, accountId: 'smoke-chatgpt' }));
        return;
      }

      if (request.url === '/projects') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ projects: allProjects }));
        return;
      }

      if (request.url === '/code/projects') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ projects: [codeProject] }));
        return;
      }

      if (request.url === '/notes/projects') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ projects: [notesProject] }));
        return;
      }

      if (request.url === '/chat/projects') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ projects: [generalProject] }));
        return;
      }

      if (request.url === '/chat/threads') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ threads: smokeThreads }));
        return;
      }

      if (request.url === '/notes/vault/index' && request.method === 'POST') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          path: '',
          entries: [],
          notes: [],
          attachments: [],
          backlinks: {},
          checkedAt: now,
        }));
        return;
      }

      if (request.url === '/portal' || request.url === '/portals') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          portals: [
            {
              portalId: 'smoke-portal',
              userId: 'smoke-user',
              name: 'Smoke Portal',
              status: 'online',
              capabilities: [
                'portal.terminal.session',
                'portal.window.session',
                'portal.window.list',
                'portal.applications.list',
                'portal.applications.open',
              ],
              roots: [{ id: 'default', name: 'Default' }],
              primary: true,
            },
          ],
        }));
        return;
      }

      if (
        request.url?.startsWith('/portal/window-sessions/windows') ||
        request.url?.startsWith('/window-sessions/windows')
      ) {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          portalId: 'smoke-portal',
          ok: true,
          windows: [{
            id: 'sck:1',
            title: 'Smoke Window',
            appName: 'Smoke App',
            bundleIdentifier: 'com.example.smoke',
            pid: 100,
          }],
        }));
        return;
      }

      if (
        request.url === '/portal/window-sessions/applications/open' ||
        request.url === '/window-sessions/applications/open'
      ) {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          portalId: 'smoke-portal',
          ok: true,
          application: {
            id: 'bundle:com.example.smoke',
            name: 'Smoke App',
            path: '/Applications/Smoke.app',
            bundleIdentifier: 'com.example.smoke',
            isRunning: true,
            pids: [100],
          },
        }));
        return;
      }

      if (
        request.url?.startsWith('/portal/window-sessions/applications') ||
        request.url?.startsWith('/window-sessions/applications')
      ) {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          portalId: 'smoke-portal',
          ok: true,
          applications: [{
            id: 'bundle:com.example.smoke',
            name: 'Smoke App',
            path: '/Applications/Smoke.app',
            bundleIdentifier: 'com.example.smoke',
            isRunning: true,
            pids: [100],
          }],
        }));
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

  it.skipIf(smokeClientApp !== 'flare')('exercises disconnected auth, saved auth, Flare shell render, shortcuts, and no renderer Node API', async () => {
    app = await electron.launch({
      args: [path.resolve(testDirectory, '../.vite/build/main.js')],
      env: {
        ...process.env,
        WEAVE_CLIENT_APP: 'flare',
        VITE_WEAVE_CLIENT_APP: 'flare',
        WEAVE_DESKTOP_SERVER_URL: serverUrl,
        WEAVE_DESKTOP_USER_DATA: userDataPath,
        WEAVE_AUTH_TOKEN: '',
      },
    });

    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.getByLabel('Auth token').waitFor({ timeout: 5_000 });

    await page.getByLabel('Auth token').fill('test-token');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByLabel('Connection settings').waitFor({ timeout: 5_000 });
    expect(await app.evaluate(({ app }) => app.getName())).toBe('Flare');
    await playwrightExpect(page).toHaveTitle('Flare');
    expect(await page.locator('html').getAttribute('data-weave-client-app')).toBe('flare');
    const hideSidebarAppRegion = await page.getByRole('button', { name: 'Hide sidebar' }).evaluate(element =>
      getComputedStyle(element).getPropertyValue('-webkit-app-region'),
    );
    const hideSidebarIconAppRegion = await page.getByRole('button', { name: 'Hide sidebar' }).locator('svg').evaluate(element =>
      getComputedStyle(element).getPropertyValue('-webkit-app-region'),
    );
    expect(hideSidebarAppRegion === 'drag').toBe(false);
    expect(hideSidebarIconAppRegion === 'drag').toBe(false);
    await playwrightExpect(page.getByRole('button', { name: 'Switch to Threads' })).toHaveCount(0);
    await playwrightExpect(page.getByRole('button', { name: 'Switch to Code' })).toHaveCount(0);
    const appHeader = page.locator('header').first();
    const appBarBreadcrumb = appHeader.locator('[data-weave-context-breadcrumb]');
    await playwrightExpect(appBarBreadcrumb).toBeVisible({ timeout: 5_000 });
    await playwrightExpect(appBarBreadcrumb).toContainText('Smoke Code');
    await playwrightExpect(appBarBreadcrumb).toContainText('main');
    await playwrightExpect(page.locator('[data-weave-main-pane="editor"] [data-weave-context-breadcrumb]')).toHaveCount(0);
    await playwrightExpect(page.locator('[data-weave-main-pane="chat"] [data-weave-context-breadcrumb]')).toHaveCount(0);
    const generalTerminalToggle = page.getByRole('button', { name: 'Show general terminal' });
    await generalTerminalToggle.waitFor({ timeout: 5_000 });
    await playwrightExpect(generalTerminalToggle.locator('[data-weave-terminal-count-badge]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Hide sidebar' }).click();
    const showSidebarButton = page.getByRole('button', { name: 'Show sidebar' }).first();
    await showSidebarButton.waitFor({ timeout: 5_000 });
    await showSidebarButton.click();
    await page.getByRole('button', { name: 'Hide sidebar' }).waitFor({ timeout: 5_000 });
    await page.getByRole('button', { name: 'Create thread in main' }).click();
    await playwrightExpect(page.locator('[data-weave-main-pane="chat"] [data-weave-context-breadcrumb]')).toHaveCount(0);

    await playwrightExpect(page.getByRole('button', { name: 'Show window stream' })).toHaveCount(0);
    await playwrightExpect(page.locator('[data-weave-window-stream-overlay]')).toHaveCount(0);

    const shortcut = process.platform === 'darwin' ? 'Meta+Shift+K' : 'Control+Shift+K';
    const composer = page.locator('[data-weave-active-thread="true"] textarea');
    await composer.waitFor({ state: 'visible', timeout: 5_000 });
    await playwrightExpect(composer).toBeEnabled({ timeout: 5_000 });
    await composer.focus({ timeout: 5_000 });
    const shortcutOverlay = page.locator('[data-weave-shortcut-overlay]');

    await page.keyboard.press(shortcut);
    await page.keyboard.press('s');
    await page.getByRole('button', { name: 'Show sidebar' }).first().waitFor({ timeout: 5_000 });
    await page.waitForTimeout(900);
    await playwrightExpect(shortcutOverlay).toBeHidden({ timeout: 1_000 });

    await composer.focus({ timeout: 5_000 });
    await page.keyboard.press(shortcut);
    await playwrightExpect(shortcutOverlay).toBeVisible({ timeout: 5_000 });
    await playwrightExpect(shortcutOverlay.getByText('Toggle sidebar')).toBeVisible({ timeout: 5_000 });
    await playwrightExpect(shortcutOverlay.getByText('Toggle terminal')).toBeVisible({ timeout: 5_000 });
    await playwrightExpect(shortcutOverlay.getByText('Toggle editor')).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('c');
    await playwrightExpect(shortcutOverlay).toBeHidden({ timeout: 5_000 });
    await playwrightExpect(composer).toBeFocused({ timeout: 5_000 });

    expect(await page.evaluate(() => typeof window.require)).toBe('undefined');
    expect(await page.locator('body').evaluate(element => getComputedStyle(element).colorScheme)).toBe('dark');
  }, 60_000);

  it.skipIf(smokeClientApp !== 'coppermind')('mounts Coppermind with Notes and Threads but no code-only controls', async () => {
    app = await electron.launch({
      args: [path.resolve(testDirectory, '../.vite/build/main.js')],
      env: {
        ...process.env,
        WEAVE_CLIENT_APP: 'coppermind',
        VITE_WEAVE_CLIENT_APP: 'coppermind',
        WEAVE_DESKTOP_SERVER_URL: serverUrl,
        WEAVE_DESKTOP_USER_DATA: userDataPath,
        WEAVE_AUTH_TOKEN: '',
      },
    });

    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.getByLabel('Auth token').waitFor({ timeout: 5_000 });
    await page.getByLabel('Auth token').fill('test-token');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByLabel('Connection settings').waitFor({ timeout: 5_000 });

    expect(await app.evaluate(({ app }) => app.getName())).toBe('Coppermind');
    await playwrightExpect(page).toHaveTitle('Coppermind');
    expect(await page.locator('html').getAttribute('data-weave-client-app')).toBe('coppermind');
    await playwrightExpect(page.getByRole('button', { name: 'Switch to Notes' })).toHaveCount(0);
    await playwrightExpect(page.getByRole('button', { name: 'Switch to Threads' })).toHaveCount(0);
    await playwrightExpect(page.getByRole('button', { name: 'Switch to Code' })).toHaveCount(0);
    await playwrightExpect(page.getByRole('button', { name: 'Show general terminal' })).toHaveCount(0);
    await playwrightExpect(page.getByRole('button', { name: 'Show window stream' })).toHaveCount(0);
    const appHeader = page.locator('header').first();
    const appBarBreadcrumb = appHeader.locator('[data-weave-context-breadcrumb]');
    await playwrightExpect(appBarBreadcrumb).toBeVisible({ timeout: 5_000 });
    await playwrightExpect(appBarBreadcrumb).toContainText('Smoke Notes');
    await playwrightExpect(appBarBreadcrumb).toContainText('Vault');
    await playwrightExpect(page.locator('[data-weave-main-pane="editor"] [data-weave-context-breadcrumb]')).toHaveCount(0);
    const sidebar = page.locator('[data-weave-thread-sidebar]');
    await playwrightExpect(sidebar.getByText('Loose thought')).toBeVisible();
    await playwrightExpect(sidebar.getByText('Smoke Notes')).toBeVisible();
    await playwrightExpect(sidebar.getByText('Smoke Threads')).toBeVisible();
    await playwrightExpect(sidebar.getByText('Smoke Code')).toHaveCount(0);
    const threadBox = await sidebar.getByText('Loose thought').boundingBox();
    const projectsBox = await sidebar.getByText('Projects', { exact: true }).boundingBox();
    expect(threadBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(projectsBox?.y ?? 0);
    await sidebar.getByText('Loose thought').click();
    await playwrightExpect(appBarBreadcrumb).toContainText('Loose thought');
    await playwrightExpect(page.locator('[data-weave-main-pane="chat"] [data-weave-context-breadcrumb]')).toHaveCount(0);
    await playwrightExpect(page.getByRole('button', { name: 'Hide notes' })).toHaveCount(0);
    await playwrightExpect(page.getByRole('button', { name: 'Show notes' })).toHaveCount(0);
  }, 60_000);
});
