import { app, BrowserWindow, ipcMain, Menu, ClipboardItem, clipboard, net, protocol, screen, session, shell } from 'electron';
import { join, relative, resolve } from 'node:path';
import { release } from 'node:os';
import { pathToFileURL } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { installNativeTerminals } from './native-terminal';
declare const ALPHA_ACCEPTANCE: boolean;

const appOrigin = 'weave://app';
protocol.registerSchemesAsPrivileged([{ scheme: 'weave', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setName('Weave Alpha');
const liveAcceptance = ALPHA_ACCEPTANCE && process.argv.includes('--host-acceptance');
const acceptance = liveAcceptance;
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
      backgroundColor: '#00000000', show: false,
      ...(process.platform === 'darwin' ? { titleBarStyle: 'hidden' as const, titleBarOverlay: true, trafficLightPosition: { x: 12, y: 9 } } : {}),
      webPreferences: { preload: join(import.meta.dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false },
    });
    const native = installNativeTerminals(window);
    const contents = window.webContents;
    const hostWindow = window;
    let topRailHeight = 32;
    // AppKit owns pointer events over draggable chrome, so CSS :hover cannot
    // reveal its actions. Track only the focused window's top rail, in CSS units.
    let pointerTimer: ReturnType<typeof setInterval> | undefined;
    let lastPointer = '';
    const reportTitlebarPointer = (point: { x: number; y: number } | null) => {
      const value = JSON.stringify(point);
      if (value === lastPointer || contents.isDestroyed()) return;
      lastPointer = value;
      contents.send('weave:titlebar-pointer', point);
    };
    const trackTitlebarPointer = () => {
      const cursor = screen.getCursorScreenPoint();
      const bounds = hostWindow.getContentBounds();
      const zoom = contents.getZoomFactor();
      const x = (cursor.x - bounds.x) / zoom, y = (cursor.y - bounds.y) / zoom;
      reportTitlebarPointer(x >= 0 && x < bounds.width / zoom && y >= 0 && y < topRailHeight ? { x, y } : null);
    };
    const stopTitlebarPointer = () => {
      clearInterval(pointerTimer); pointerTimer = undefined;
      reportTitlebarPointer(null);
    };
    hostWindow.on('focus', () => {
      if (pointerTimer) return;
      trackTitlebarPointer();
      pointerTimer = setInterval(trackTitlebarPointer, 50);
    });
    hostWindow.on('blur', stopTitlebarPointer);
    hostWindow.once('closed', stopTitlebarPointer);
    let windowButtonHeight: number | undefined;
    let windowButtonInsetY = 9;
    const positionWindowButtons = () => {
      if (process.platform === 'darwin' && windowButtonHeight !== undefined && !hostWindow.isDestroyed() && !hostWindow.isFullScreen()) {
        const y = Math.max(0, Math.round((topRailHeight * contents.getZoomFactor() - windowButtonHeight) / 2));
        if (y === windowButtonInsetY) return;
        windowButtonInsetY = y;
        hostWindow.setWindowButtonPosition({ x: 12, y });
      }
    };
    ipcMain.handle('weave:top-rail-height', (event, height: unknown, overlayHeight: unknown) => {
      if (event.sender !== contents || event.senderFrame !== contents.mainFrame || !event.senderFrame.url.startsWith(`${appOrigin}/`) || typeof height !== 'number' || !Number.isFinite(height) || height < 16 || height > 128 || typeof overlayHeight !== 'number' || !Number.isFinite(overlayHeight) || overlayHeight < 0 || overlayHeight > 256) throw new Error('Invalid window rail geometry.');
      // Electron's overlay height is the Cocoa button frame plus twice its
      // vertical inset. Calibrate once from native geometry instead of assuming
      // a fixed macOS button height; overlay coordinates are already CSS pixels.
      if (windowButtonHeight === undefined && overlayHeight > 0 && !hostWindow.isFullScreen()) {
        const measured = Math.round(overlayHeight * contents.getZoomFactor()) - 2 * windowButtonInsetY;
        if (measured >= 10 && measured <= 24) windowButtonHeight = measured;
      }
      topRailHeight = height; positionWindowButtons();
      // Match the titlebar-only native window corner, in zoom-adjusted CSS units.
      const radius = Number.parseInt(release(), 10) >= 25 ? 16 : 10;
      return hostWindow.isFullScreen() ? 0 : radius / contents.getZoomFactor();
    });
    hostWindow.on('leave-full-screen', positionWindowButtons);
    hostWindow.once('closed', () => ipcMain.removeHandler('weave:top-rail-height'));
    contents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
    contents.on('will-navigate', (event, url) => { event.preventDefault(); external(url); });
    contents.on('will-redirect', (event) => event.preventDefault());
    contents.on('will-attach-webview', (event) => event.preventDefault());
    window.once('ready-to-show', () => window?.show());
    window.on('closed', () => { window = undefined; });
    await window.loadURL(`${appOrigin}/index.html${liveAcceptance ? '?acceptance=live' : ''}`);
    if (acceptance) {
      if (liveAcceptance) {
        const input = JSON.parse(await readFile(join(evidence, 'input.json'), 'utf8'));
        await contents.executeJavaScript(`window.alphaAcceptanceInput = ${JSON.stringify(input)}`);
      }
      const handled = new Set<string>();
      const paste = async (text: string) => {
        const saved = await Promise.all((await clipboard.read()).filter(item => item.types.length > 0).map(async (item) => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async (type) => [type, await item.getType(type)]))))));
        try { await clipboard.writeText(text); native.acceptance('paste'); await new Promise((resolve) => setTimeout(resolve, 200)); }
        finally { if (saved.length) await clipboard.write(saved); else clipboard.clear(); }
      };
      const key = (keyCode: string) => native.acceptance('key', keyCode);
      let result: { passed?: boolean } | undefined;
      for (let attempt = 0; attempt < 1800 && !result; attempt++) {
        result = await contents.executeJavaScript('window.alphaAcceptance');
        const stage = await contents.executeJavaScript('window.alphaAcceptanceStage');
        const stageKey = `${await contents.executeJavaScript('window.alphaAcceptanceIndex')}:${stage}`;
        if (liveAcceptance && stage && !handled.has(stageKey)) {
          window?.show(); app.focus({ steal: true }); window?.focus();
          // Native input needs an exposed AppKit surface. macOS can occlude the
          // acceptance window while the driver awaits clipboard operations.
          for (let retry = 0; ; retry++) {
            try { await contents.executeJavaScript('window.alphaAcceptanceFocusTerminal?.()'); break; }
            catch (error) { if (retry >= 20) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
          }
          handled.add(stageKey);
          if (stage === 'native-pane-focus') {
            await contents.executeJavaScript('window.alphaAcceptanceStage = undefined');
          } else if (stage === 'native-terminal') {
            await paste("printf 'WEAVE_NATIVE_PASTE_OK\\n'"); key('Enter');
            window?.setSize(1100, 780);
          } else if (stage === 'native-neovim') {
            await paste('nvim -u NONE -i NONE'); key('Enter');
          } else if (stage === 'native-neovim-input') {
            key('i');
            await paste('WEAVE_NEOVIM_INPUT');
          } else if (stage === 'native-composition') {
            native.acceptance('composition', '界é');
          } else if (stage === 'native-reattached-input') {
            await paste('_REATTACHED');
          } else if (stage === 'native-finish') {
            if (native) {
              const saved = await Promise.all((await clipboard.read()).filter(item => item.types.length > 0).map(async (item) => new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async (type) => [type, await item.getType(type)]))))));
              try {
                native.acceptance('copyMarker', 'WEAVE_NEOVIM_INPUT');
                if (!(await clipboard.readText()).includes('WEAVE_NEOVIM_INPUT')) throw new Error('Native selection copy failed.');
                const png = native.acceptance('capture');
                if (png) await writeFile(join(evidence, 'native-terminal.png'), png);
              } finally { if (saved.length) await clipboard.write(saved); else clipboard.clear(); }
            }
            // Leave Neovim visible; the harness closes its dedicated Terminal Service.
            window?.setSize(1400, 920);
            await contents.executeJavaScript('window.alphaAcceptanceStage = "native-finished"');
          }
        }
        if (!result) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (result?.passed && !await contents.executeJavaScript('isSecureContext && typeof require === "undefined" && typeof window.ipcRenderer === "undefined"')) throw new Error('Renderer isolation check failed');
      await mkdir(evidence, { recursive: true });
      if (result?.passed) {
        const png = native.acceptance('capture');
        if (png) await writeFile(join(evidence, 'native-reattached.png'), png);
      }
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
