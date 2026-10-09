import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { prepareNodeApiHeaders } from '../../scripts/native-headers';

assert(process.platform === 'darwin', 'Client Browser window acceptance requires macOS.');
const root = resolve(import.meta.dir, '..');
const addon = process.argv[2] ? resolve(process.argv[2]) : join(root, 'native/.build/client-browser/weave-client-browser.node');
const terminalAddon = process.argv[3] ? resolve(process.argv[3]) : join(root, 'native/.build/macos/weave-terminal.node');
assert(await Bun.file(addon).exists(), 'Build the native Client Browser first.');
const manifest = await Bun.file(join(root, 'package.json')).json();
const headers = await prepareNodeApiHeaders(manifest.devDependencies.electron);
const directory = await mkdtemp('/tmp/weave-client-browser-window-');
try {
  const compile = Bun.spawn(['xcrun', 'clang++', '-std=c++17', '-fobjc-arc', '-fmodules', '-shared', '-undefined', 'dynamic_lookup', '-I', headers,
    join(root, 'native/client-browser/window-geometry-test.mm'), '-framework', 'AppKit', '-o', join(directory, 'geometry.node')], { stdout: 'inherit', stderr: 'inherit' });
  assert.equal(await compile.exited, 0, 'Window geometry probe compilation failed.');
  await writeFile(join(directory, 'main.cjs'), `
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const geometry = require('./geometry.node');
const addon = require(${JSON.stringify(addon)});
const terminals = require(${JSON.stringify(terminalAddon)});
const http = require('node:http');
app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  for (const titleBarStyle of ['hidden', 'normal']) for (const terminalFirst of [false, true]) {
    const window = new BrowserWindow({ width: 1000, height: 700, show: false, titleBarStyle,
      ...(titleBarStyle === 'hidden' ? { titleBarOverlay: true, trafficLightPosition: { x: 12, y: 9 } } : {}) });
    let terminal, browser;
    try {
      const pointer = window.getNativeWindowHandle();
      const inspect = () => JSON.parse(geometry.inspect(pointer));
      const before = inspect();
      const nativeInset = before.windowHeight - before.contentHeight;
      const createTerminal = () => terminals.create(window.getNativeWindowHandle(), () => {}, ${JSON.stringify(join(root, 'src/assets/fonts/TerminalFonts'))});
      if (terminalFirst) terminal = createTerminal();
      addon.prepare(pointer);
      browser = addon.create(window.getNativeWindowHandle(), 'about:blank', () => {});
      if (!terminalFirst) terminal = createTerminal();
      addon.layout(browser, 500, 100, 400, 300, false, true);
      await window.loadURL('data:text/html,<html><body>Window chrome fixture</body></html>');
      const check = (width, height) => {
        const current = inspect();
        assert.equal(current.contentWidth, width);
        assert.equal(current.contentHeight, height - nativeInset, titleBarStyle + ' titlebar displaced the shell');
        assert.equal(current.contentY, before.contentY);
        assert.equal(current.shellWidth, current.contentWidth, 'Electron shell lost its mouse hit-test width');
        assert.equal(current.shellHeight, current.contentHeight, 'Electron shell lost its mouse hit-test height');
        assert.equal(current.hitShell, true, 'Mouse hit testing missed the Electron shell');
        return current;
      };
      check(1000, 700);
      addon.prepare(pointer);
      check(1000, 700);
      window.setSize(1100, 800);
      await new Promise(resolve => setTimeout(resolve, 100));
      const resized = check(1100, 800);
      console.log(JSON.stringify({ titleBarStyle, terminalFirst, before, resized, passed: true }));
    } finally {
      if (browser !== undefined) addon.close(browser);
      if (terminal !== undefined) terminals.close(terminal);
      window.destroy();
    }
  }
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.setHeader('Content-Type', 'text/html');
    const icon = request.url === '/first' ? '<link rel="shortcut icon" href="/first.svg">' : '';
    const dynamic = request.url === '/dynamic' ? '<link rel="icon" href="/initial.svg"><script>setTimeout(() => { document.title = "Updated title"; document.querySelector("link").href = "/updated.svg"; }, 500)</script>' : '';
    response.end('<title>' + request.url + '</title>' + icon + dynamic + '<p>Local navigation fixture</p>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const window = new BrowserWindow({ show: false, titleBarStyle: 'hidden' });
  let browser;
  try {
    addon.prepare(window.getNativeWindowHandle());
    browser = addon.create(window.getNativeWindowHandle(), 'about:blank', () => {}, 'window-chrome-acceptance-' + Date.now());
    addon.layout(browser, 0, 80, 800, 400, true, false);
    const snapshot = () => JSON.parse(addon.snapshot(browser));
    const identity = snapshot().pageIdentity;
    const waitFor = async check => {
      const deadline = Date.now() + 5000;
      while (!check()) {
        assert(Date.now() < deadline, 'Native navigation timed out: ' + JSON.stringify(snapshot()));
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    for (const address of ['javascript:alert(1)', 'file:///tmp/private', 'about:config']) assert.throws(() => addon.command(browser, 'navigate', address), /Invalid browser command/);
    assert.throws(() => addon.command(browser, 'evaluate', '1 + 1'), /Invalid browser command/);
    addon.command(browser, 'navigate', origin + '/first');
    await waitFor(() => snapshot().title === '/first' && !snapshot().loading);
    await waitFor(() => snapshot().faviconUrl === origin + '/first.svg');
    addon.command(browser, 'navigate', origin + '/second');
    await waitFor(() => snapshot().title === '/second' && !snapshot().loading);
    await waitFor(() => snapshot().faviconUrl === origin + '/favicon.ico');
    assert.equal(snapshot().canGoBack, true);
    addon.command(browser, 'back', '');
    await waitFor(() => snapshot().title === '/first' && !snapshot().loading);
    assert.equal(snapshot().canGoForward, true);
    addon.command(browser, 'forward', '');
    await waitFor(() => snapshot().title === '/second' && !snapshot().loading);
    const beforeReload = requests.filter(path => path === '/second').length;
    addon.command(browser, 'reload', '');
    await waitFor(() => requests.filter(path => path === '/second').length > beforeReload && !snapshot().loading);
    addon.command(browser, 'stop', '');
    addon.command(browser, 'navigate', origin + '/dynamic');
    addon.layout(browser, 0, 80, 800, 400, false, true);
    await waitFor(() => snapshot().title === 'Updated title' && snapshot().faviconUrl === origin + '/updated.svg');
    assert.equal(snapshot().hidden, true, 'Reading metadata presented a hidden page');
    addon.command(browser, 'navigate', 'about:blank');
    await waitFor(() => snapshot().url === 'about:blank' && snapshot().faviconUrl === '');
    assert.equal(snapshot().pageIdentity, identity, 'Toolbar navigation replaced the native page');
    console.log(JSON.stringify({ nativeNavigation: true, localFaviconMetadata: true, hiddenPageMetadata: true, invalidCommandsRejected: true, pageIdentityRetained: true, passed: true }));
  } finally {
    if (browser !== undefined) addon.close(browser);
    window.destroy(); server.close();
  }
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
`);
  const child = Bun.spawn([join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), join(directory, 'main.cjs')], { stdout: 'inherit', stderr: 'inherit' });
  const timeout = setTimeout(() => child.kill(), 30_000);
  try { assert.equal(await child.exited, 0, 'Client Browser window acceptance failed.'); }
  finally { clearTimeout(timeout); }
} finally { await rm(directory, { recursive: true, force: true }); }
