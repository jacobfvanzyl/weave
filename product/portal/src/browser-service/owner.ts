import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { ChromiumProcess, privateDirectory } from './chromium.ts';
import { BrowserMedia } from './media.ts';
import { ManagedBrowserPages } from './managed-pages.ts';
import { BrowserProfiles } from './profiles.ts';
type Runtime = { browser: ChromiumProcess; generation: string; media?: BrowserMedia };

type BrowserRuntimeSummary = { generation: string; pid: number; version: string; available: boolean; failure?: string };
export type WorkspaceBrowser = BrowserRuntimeSummary & { workspaceId: string };
export type ProfileBrowser = BrowserRuntimeSummary & { profileId: string };

/** Lives in the Browser Service process, independently of Portal connections. */
export class BrowserOwner {
  readonly generation = crypto.randomUUID();
  #browsers = new Map<string, Promise<Runtime>>();
  #profiles = new Map<string, Promise<Runtime>>();
  readonly profiles: BrowserProfiles;
  readonly managedPages?: ManagedBrowserPages;
  #closing?: Promise<void>;
  constructor(readonly stateDirectory: string, readonly binary: string, cefBinary?: string) {
    this.profiles = new BrowserProfiles(stateDirectory);
    if (cefBinary) this.managedPages = new ManagedBrowserPages(join(stateDirectory, 'browser-service'), cefBinary, this.profiles);
  }
  async openProfile(profileId: string): Promise<ProfileBrowser> {
    if (this.managedPages) throw new Error('Managed CEF Profiles use page operations; the legacy Chrome Profile runtime is disabled');
    if (this.#closing) throw new Error('Browser Service is stopping');
    await this.profiles.require(profileId);
    if (this.#closing) throw new Error('Browser Service is stopping');
    let pending = this.#profiles.get(profileId);
    if (!pending) {
      if (this.#profiles.size + this.#browsers.size >= 16) throw new Error('Browser runtime capacity exceeded');
      pending = this.profiles.dataDirectory(profileId).then(async directory => ({
        browser: await ChromiumProcess.launch({ binary: this.binary, directory }), generation: crypto.randomUUID(),
      }));
      this.#profiles.set(profileId, pending);
      void pending.catch(() => { if (this.#profiles.get(profileId) === pending) this.#profiles.delete(profileId); });
    }
    const runtime = await pending;
    return { profileId, ...this.#summary(runtime) };
  }
  async profileCommand(profileId: string, generation: string, method: string, params: object, sessionId?: string) {
    const pending = this.#profiles.get(profileId);
    if (!pending) throw new Error('Browser Profile is not open');
    const runtime = await pending;
    if (runtime.generation !== generation) throw new Error('Stale Browser Profile generation');
    if (!runtime.browser.available) throw new Error(runtime.browser.failure ?? 'Browser Profile unavailable');
    return runtime.browser.send(method, params, sessionId);
  }
  async open(workspaceId: string): Promise<WorkspaceBrowser> {
    if (this.#closing) throw new Error('Browser Service is stopping');
    workspaceKey(workspaceId);
    let pending = this.#browsers.get(workspaceId);
    if (!pending) {
      if (this.#profiles.size + this.#browsers.size >= 16) throw new Error('Browser runtime capacity exceeded');
      pending = this.#launch(workspaceId);
      this.#browsers.set(workspaceId, pending);
      void pending.catch(() => { if (this.#browsers.get(workspaceId) === pending) this.#browsers.delete(workspaceId); });
    }
    const runtime = await pending;
    return { workspaceId, ...this.#summary(runtime) };
  }
  async #launch(workspaceId: string) {
    const directory = resolve(this.stateDirectory, 'browser-service');
    await privateDirectory(directory);
    await privateDirectory(join(directory, 'profiles'));
    const browser = await ChromiumProcess.launch({ binary: this.binary, directory: join(directory, 'profiles', workspaceKey(workspaceId)) });
    return { browser, generation: crypto.randomUUID() };
  }
  #summary(runtime: { browser: ChromiumProcess; generation: string }): BrowserRuntimeSummary {
    return { generation: runtime.generation, pid: runtime.browser.pid, version: runtime.browser.version, available: runtime.browser.available,
      ...(runtime.browser.failure ? { failure: runtime.browser.failure } : {}) };
  }
  async list() {
    const records = await Promise.all([...this.#browsers].map(async ([workspaceId, pending]) => ({ workspaceId, ...this.#summary(await pending) })));
    return records;
  }
  async command(workspaceId: string, generation: string, method: string, params: object, sessionId?: string) {
    const pending = this.#browsers.get(workspaceId);
    if (!pending) throw new Error('Workspace browser is not open');
    const runtime = await pending;
    if (runtime.generation !== generation) throw new Error('Stale Workspace browser generation');
    if (!runtime.browser.available) throw new Error(runtime.browser.failure ?? 'Workspace browser unavailable');
    return runtime.browser.send(method, params, sessionId);
  }
  async media(workspaceId: string, create = false) {
    if (create) await this.open(workspaceId);
    const pending = this.#browsers.get(workspaceId);
    if (!pending) throw new Error('Workspace browser unavailable');
    const runtime = await pending;
    if (!runtime.browser.available) throw new Error('Workspace browser unavailable');
    if (create) runtime.media ??= new BrowserMedia(workspaceId, runtime.browser);
    if (!runtime.media) throw new Error('Workspace browser media unavailable');
    return runtime.media;
  }
  async closeWorkspace(workspaceId: string, generation: string) {
    const pending = this.#browsers.get(workspaceId);
    if (!pending) throw new Error('Workspace browser is not open');
    const runtime = await pending;
    if (runtime.generation !== generation) throw new Error('Stale Workspace browser generation');
    await runtime.media?.close();
    await runtime.browser.close();
    if (this.#browsers.get(workspaceId) === pending) this.#browsers.delete(workspaceId);
  }
  close() {
    return this.#closing ??= (async () => {
      const results = await Promise.allSettled([...this.#browsers.values(), ...this.#profiles.values()].map(async pending => {
        const runtime = await pending;
        try { await runtime.media?.close(); } finally { await runtime.browser.close(); }
      }));
      await this.managedPages?.close();
      this.#browsers.clear();
      this.#profiles.clear();
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    })();
  }
}

export function workspaceKey(workspaceId: string) {
  if (typeof workspaceId !== 'string' || !workspaceId.trim() || workspaceId.length > 256 || workspaceId.includes('\0')) throw new Error('Invalid Workspace identity');
  return createHash('sha256').update(workspaceId).digest('hex');
}
