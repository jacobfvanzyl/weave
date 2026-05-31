import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect as playwrightExpect, type ElectronApplication } from '@playwright/test';
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
      response.setHeader('access-control-allow-origin', '*');
      response.setHeader('access-control-allow-headers', 'authorization, content-type');
      if (request.method === 'OPTIONS') {
        response.statusCode = 204;
        response.end();
        return;
      }

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

      if (request.url === '/chatgpt/auth-status') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ connected: true, accountId: 'smoke-chatgpt' }));
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

  it('exercises disconnected auth, saved auth, chat shell render, shortcuts, and no renderer Node API', async () => {
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
    await page.getByLabel('Auth token').waitFor({ timeout: 5_000 });

    await page.getByLabel('Auth token').fill('test-token');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByLabel('Connection settings').waitFor({ timeout: 5_000 });
    const hideSidebarAppRegion = await page.getByRole('button', { name: 'Hide sidebar' }).evaluate(element =>
      getComputedStyle(element).getPropertyValue('-webkit-app-region'),
    );
    const hideSidebarIconAppRegion = await page.getByRole('button', { name: 'Hide sidebar' }).locator('svg').evaluate(element =>
      getComputedStyle(element).getPropertyValue('-webkit-app-region'),
    );
    expect(hideSidebarAppRegion === 'drag').toBe(false);
    expect(hideSidebarIconAppRegion === 'drag').toBe(false);
    const generalTerminalToggle = page.getByRole('button', { name: 'Show general terminal' });
    await generalTerminalToggle.waitFor({ timeout: 5_000 });
    await playwrightExpect(generalTerminalToggle.locator('[data-weave-terminal-count-badge]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Hide sidebar' }).click();
    await page.getByRole('button', { name: 'Show sidebar' }).first().waitFor({ timeout: 5_000 });

    await page.getByRole('button', { name: 'Show general terminal' }).click();
    const generalTerminalOverlay = page.locator('[data-weave-general-terminal-overlay]');
    await playwrightExpect(generalTerminalOverlay).toBeVisible({ timeout: 5_000 });
    await playwrightExpect(generalTerminalOverlay.locator('[data-terminal-kind="general"]')).toBeVisible({ timeout: 5_000 });
    await playwrightExpect(page.getByRole('button', { name: 'Hide general terminal' }).locator('[data-weave-terminal-count-badge]')).toHaveText('1');
    await generalTerminalOverlay.getByRole('button', { name: 'New terminal tab' }).click();
    await playwrightExpect(generalTerminalOverlay.getByRole('tab')).toHaveCount(2);
    await playwrightExpect(page.getByRole('button', { name: 'Hide general terminal' }).locator('[data-weave-terminal-count-badge]')).toHaveText('2');
    await generalTerminalOverlay.getByRole('button', { name: /^Close / }).nth(1).click();
    await playwrightExpect(generalTerminalOverlay.getByRole('tab')).toHaveCount(1);
    await playwrightExpect(page.getByRole('button', { name: 'Hide general terminal' }).locator('[data-weave-terminal-count-badge]')).toHaveText('1');
    const terminalBounds = await generalTerminalOverlay.locator('[data-weave-terminal-panel]').boundingBox();
    const appbarBounds = await page.locator('header').boundingBox();
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    if (!terminalBounds || !appbarBounds) throw new Error('Terminal overlay geometry was not measurable.');
    const appbarBottomFromWindowEdge = appbarBounds.y + appbarBounds.height;
    expect(terminalBounds.x).toBeCloseTo(appbarBottomFromWindowEdge, 0);
    expect(terminalBounds.y).toBeCloseTo(appbarBottomFromWindowEdge, 0);
    expect(viewport.width - terminalBounds.x - terminalBounds.width).toBeCloseTo(appbarBottomFromWindowEdge, 0);
    expect(viewport.height - terminalBounds.y - terminalBounds.height).toBeCloseTo(appbarBottomFromWindowEdge, 0);
    await generalTerminalOverlay.getByRole('button', { name: /^Close / }).first().click();
    await playwrightExpect(generalTerminalOverlay).toBeHidden({ timeout: 5_000 });
    await playwrightExpect(page.getByRole('button', { name: 'Show general terminal' }).locator('[data-weave-terminal-count-badge]')).toHaveCount(0);

    const shortcut = process.platform === 'darwin' ? 'Meta+Shift+K' : 'Control+Shift+K';
    const composer = page.locator('[data-weave-active-thread="true"] textarea');
    await composer.waitFor({ state: 'visible', timeout: 5_000 });
    await playwrightExpect(composer).toBeEnabled({ timeout: 5_000 });
    await composer.focus({ timeout: 5_000 });
    const shortcutOverlay = page.locator('[data-weave-shortcut-overlay]');

    await page.keyboard.press(shortcut);
    await page.keyboard.press('s');
    await page.getByRole('button', { name: 'Hide sidebar' }).waitFor({ timeout: 5_000 });
    await page.waitForTimeout(900);
    await playwrightExpect(shortcutOverlay).toBeHidden({ timeout: 1_000 });

    await composer.focus({ timeout: 5_000 });
    await page.keyboard.press(shortcut);
    await playwrightExpect(shortcutOverlay).toBeVisible({ timeout: 5_000 });
    await playwrightExpect(shortcutOverlay.getByText('Toggle sidebar')).toBeVisible({ timeout: 5_000 });
    await playwrightExpect(shortcutOverlay.locator('[aria-disabled="true"]').filter({ hasText: 'Toggle terminal' })).toBeVisible({ timeout: 5_000 });
    await playwrightExpect(shortcutOverlay.locator('[aria-disabled="true"]').filter({ hasText: 'Toggle editor' })).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press('c');
    await playwrightExpect(shortcutOverlay).toBeHidden({ timeout: 5_000 });
    await playwrightExpect(composer).toBeFocused({ timeout: 5_000 });

    expect(await page.evaluate(() => typeof window.require)).toBe('undefined');
    expect(await page.locator('body').evaluate(element => getComputedStyle(element).colorScheme)).toBe('dark');
  }, 60_000);
});
