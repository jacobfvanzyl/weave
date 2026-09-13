import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ChromiumProcess } from '../../product/portal/src/browser-service/chromium.ts';
import { BrowserServiceClient } from '../../product/portal/src/browser-service/client.ts';
import { workspaceKey } from '../../product/portal/src/browser-service/owner.ts';

/** The harness owns temporary fixture profiles; production profiles are retained. */
export class Chromium {
  private constructor(private browser: Pick<ChromiumProcess, 'directory' | 'version' | 'send' | 'close'>, private temporary: boolean) {}
  get directory() { return this.browser.directory; }
  get version() { return this.browser.version; }
  static async launch() {
    if (process.env.BROWSER_SERVICE_STATE) {
      const state = resolve(process.env.BROWSER_SERVICE_STATE);
      const client = new BrowserServiceClient(state);
      const workspaceId = process.env.SPIKE_WORKSPACE_ID ?? 'browser-spike';
      try {
        const browser = await client.openWorkspace(workspaceId);
        if (!browser.available) throw new Error(browser.failure ?? 'Browser unavailable');
        return new Chromium({
          directory: resolve(state, 'browser-service/profiles', workspaceKey(workspaceId)), version: browser.version,
          send: <Result = any>(method: string, params: object = {}, sessionId?: string) => client.send<Result>(workspaceId, browser.generation, method, params, sessionId),
          close: async () => { client.dispose(); },
        }, false);
      } catch (error) { client.dispose(); throw error; }
    }
    const directory = await mkdtemp(tmpdir() + '/weave-browser-spike-');
    const binary = process.env.CHROME_BINARY ?? (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
    try { return new Chromium(await ChromiumProcess.launch({ binary, directory }), true); }
    catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  }
  send(method: string, params: object = {}, sessionId?: string) { return this.browser.send(method, params, sessionId); }
  async close() {
    await this.browser.close();
    if (this.temporary) await rm(this.directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
