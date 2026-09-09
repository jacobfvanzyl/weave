import { app, BrowserWindow, Menu, ClipboardItem, clipboard, net, protocol, session, shell } from 'electron';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
declare const ALPHA_ACCEPTANCE: boolean;

const appOrigin = 'weave://app';
protocol.registerSchemesAsPrivileged([{ scheme: 'weave', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setName('Weave Alpha');
const liveAcceptance = ALPHA_ACCEPTANCE && process.argv.includes('--host-acceptance');
const acceptance = ALPHA_ACCEPTANCE && (process.argv.includes('--shell-acceptance') || liveAcceptance);
const evidence = process.env.WEAVE_ALPHA_ACCEPTANCE_DIR || '/tmp/weave-electron-acceptance';
app.setPath('userData', acceptance ? join(evidence, 'profile') : join(app.getPath('appData'), 'Weave Alpha'));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  let window: BrowserWindow | undefined;
  const external = (value: string) => {
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' || url.protocol === 'http:') void shell.openExternal(url.href);
    } catch { /* Invalid links are inert. */ }
  };
  const createWindow = async () => {
    window = new BrowserWindow({
      title: 'Weave Alpha', width: 1400, height: 920, minWidth: 680, minHeight: 480,
      backgroundColor: '#1e1e2e', show: false,
      webPreferences: { preload: join(import.meta.dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false },
    });
    const contents = window.webContents;
    contents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
    contents.on('will-navigate', (event, url) => { event.preventDefault(); external(url); });
    contents.on('will-redirect', (event) => event.preventDefault());
    contents.on('will-attach-webview', (event) => event.preventDefault());
    window.once('ready-to-show', () => window?.show());
    window.on('closed', () => { window = undefined; });
    await window.loadURL(`${appOrigin}/index.html${liveAcceptance ? '?acceptance=live' : acceptance ? '?mock=chat&acceptance=1' : ''}`);
    if (acceptance) {
      if (liveAcceptance) {
        const input = JSON.parse(await readFile(join(evidence, 'input.json'), 'utf8'));
        await contents.executeJavaScript(`window.alphaAcceptanceInput = ${JSON.stringify(input)}`);
      }
      const handled = new Set<string>();
      const paste = async (text: string) => {
        const saved = await Promise.all((await clipboard.read()).map(async (item) => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async (type) => [type, await item.getType(type)]))))));
        try { await clipboard.writeText(text); contents.paste(); await new Promise((resolve) => setTimeout(resolve, 200)); }
        finally { if (saved.length) await clipboard.write(saved); else clipboard.clear(); }
      };
      const key = (keyCode: string) => { contents.sendInputEvent({ type: 'keyDown', keyCode }); contents.sendInputEvent({ type: 'keyUp', keyCode }); };
      let result: { passed?: boolean } | undefined;
      for (let attempt = 0; attempt < 1800 && !result; attempt++) {
        result = await contents.executeJavaScript('window.alphaAcceptance');
        const stage = await contents.executeJavaScript('window.alphaAcceptanceStage');
        if (liveAcceptance && stage && !handled.has(stage)) {
          handled.add(stage);
          if (stage === 'native-terminal') {
            await paste("printf 'WEAVE_NATIVE_PASTE_OK\\n'"); key('Enter');
            window?.setSize(1100, 780);
          } else if (stage === 'native-neovim') {
            await paste('nvim -u NONE -i NONE'); key('Enter');
          } else if (stage === 'native-neovim-input') {
            key('I'); contents.sendInputEvent({ type: 'char', keyCode: 'i' });
            await paste('WEAVE_NEOVIM_INPUT');
          } else if (stage === 'native-finish') {
            const rect = await contents.executeJavaScript(`(() => {
              const row = [...document.querySelectorAll('.xterm-rows > div')].find(el => el.textContent.includes('WEAVE_NEOVIM_INPUT'));
              const r = row.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
            })()`);
            const saved = await Promise.all((await clipboard.read()).map(async (item) => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async (type) => [type, await item.getType(type)]))))));
            try {
              const y = Math.round(rect.y + rect.height / 2);
              contents.sendInputEvent({ type: 'mouseDown', x: Math.round(rect.x + 1), y, button: 'left', clickCount: 1, modifiers: ['alt'] });
              contents.sendInputEvent({ type: 'mouseMove', x: Math.round(rect.x + rect.width - 2), y, modifiers: ['leftbuttondown', 'alt'] });
              contents.sendInputEvent({ type: 'mouseUp', x: Math.round(rect.x + rect.width - 2), y, button: 'left', clickCount: 1, modifiers: ['alt'] });
              await clipboard.writeText('');
              contents.copy();
              await new Promise((resolve) => setTimeout(resolve, 150));
              const copied = await clipboard.readText();
              if (!copied.includes('WEAVE_NEOVIM_INPUT')) {
                await writeFile(join(evidence, 'copy-failure.png'), (await contents.capturePage()).toPNG());
                throw new Error(`Native terminal copy failed: ${JSON.stringify(copied)}`);
              }
            } finally { if (saved.length) await clipboard.write(saved); else clipboard.clear(); }
            // Leave Neovim visible; the harness closes its dedicated tmux server.
            window?.setSize(1400, 920);
            await contents.executeJavaScript('window.alphaAcceptanceStage = "native-finished"');
          }
        }
        if (!result) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (result?.passed && !await contents.executeJavaScript('isSecureContext && typeof require === "undefined" && typeof window.ipcRenderer === "undefined"')) throw new Error('Renderer isolation check failed');
      await mkdir(evidence, { recursive: true });
      await writeFile(join(evidence, 'result.json'), JSON.stringify(result ?? { passed: false, error: 'Timed out' }));
      await writeFile(join(evidence, 'shell.png'), (await contents.capturePage()).toPNG());
      app.exit(result?.passed ? 0 : 1);
    }
  };
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.focus(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('activate', () => { if (!window) void createWindow(); else window.focus(); });
  void app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    const assets = resolve(app.getAppPath(), 'web');
    protocol.handle('weave', async (request) => {
      const url = new URL(request.url);
      if (url.host !== 'app' || request.method !== 'GET') return new Response('Not found', { status: 404 });
      const path = resolve(assets, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
      if (relative(assets, path).startsWith('..')) return new Response('Not found', { status: 404 });
      const response = await net.fetch(pathToFileURL(path).href);
      response.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' wss: ws://127.0.0.1:* ws://localhost:*; object-src 'none'; frame-src 'none'; base-uri 'none'");
      return response;
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' }, { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
      { role: 'windowMenu' },
    ]));
    await createWindow();
  }).catch((error) => { console.error(error); app.exit(1); });
}
