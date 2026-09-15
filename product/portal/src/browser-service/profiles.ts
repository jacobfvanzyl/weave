import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { browserProfileId, browserProfileName, parseBrowserProfile, type BrowserProfile } from '@weave/product-protocol';
import { privateDirectory } from './chromium.ts';

/** Single writer: the independent Browser Service. Profiles outlive Workspace composition. */
export class BrowserProfiles {
  readonly #directory: string;
  #pending: Promise<unknown> = Promise.resolve();
  constructor(stateDirectory: string) { this.#directory = resolve(stateDirectory, 'browser-service'); }
  #ordered<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#pending.catch(() => {}).then(operation);
    this.#pending = pending;
    return pending;
  }
  async #read(): Promise<BrowserProfile[]> {
    await privateDirectory(this.#directory);
    const path = join(this.#directory, 'profiles.json');
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > 128 * 1024) throw new Error('Unsafe Browser Profile catalog');
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.profiles) || value.profiles.length > 320) throw new Error('Invalid Browser Profile catalog');
      const profiles: BrowserProfile[] = value.profiles.map(parseBrowserProfile);
      if (new Set(profiles.map(profile => profile.profileId)).size !== profiles.length || new Set(profiles.map(profile => profile.name.toLowerCase())).size !== profiles.length) throw new Error('Duplicate Browser Profile');
      return profiles;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }
  async #save(profiles: BrowserProfile[]) {
    const path = join(this.#directory, 'profiles.json');
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, profiles }) + '\n', { flag: 'wx', mode: 0o600 });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }
  list() { return this.#ordered(() => this.#read()); }
  require(profileId: string) {
    browserProfileId(profileId);
    return this.#ordered(async () => {
      const profile = (await this.#read()).find(profile => profile.profileId === profileId);
      if (!profile) throw new Error('Browser Profile unavailable');
      return profile;
    });
  }
  create(name: string) {
    name = browserProfileName(name);
    return this.#ordered(async () => {
      const profiles = await this.#read();
      if (profiles.filter(profile => !profile.temporary).length >= 64) throw new Error('Browser Profile capacity exceeded');
      if (profiles.some(profile => profile.name.toLowerCase() === name.toLowerCase())) throw new Error('Browser Profile name already exists');
      const profile = { profileId: crypto.randomUUID(), name, revision: 0 };
      await this.#save([...profiles, profile]);
      return profile;
    });
  }
  rename(profileId: string, name: string, expectedRevision: number) {
    browserProfileId(profileId); name = browserProfileName(name);
    return this.#ordered(async () => {
      const profiles = await this.#read(), profile = profiles.find(profile => profile.profileId === profileId);
      if (!profile) throw new Error('Browser Profile unavailable');
      if (profile.temporary) throw new Error('Temporary browser identities cannot be renamed');
      if (profile.revision !== expectedRevision) throw new Error('Browser Profile changed; reload before renaming');
      if (profiles.some(other => other.profileId !== profileId && other.name.toLowerCase() === name.toLowerCase())) throw new Error('Browser Profile name already exists');
      const next = parseBrowserProfile({ ...profile, name, revision: profile.revision + 1 });
      await this.#save(profiles.map(profile => profile.profileId === profileId ? next : profile));
      return next;
    });
  }
  /** Temporary Chromium storage is an implementation identity, never a named user Profile. */
  temporary(profileId: string) {
    browserProfileId(profileId);
    return this.#ordered(async () => {
      const profiles = await this.#read(), existing = profiles.find(profile => profile.profileId === profileId);
      if (existing) { if (!existing.temporary) throw new Error('Temporary identity collision'); return existing; }
      if (profiles.length >= 320) throw new Error('Browser identity capacity exceeded');
      const profile: BrowserProfile = { profileId, name: `Temporary ${profileId}`, revision: 0, temporary: true };
      await this.#save([...profiles, profile]); return profile;
    });
  }
  releaseTemporary(profileId: string) {
    return this.#ordered(async () => {
      const profiles = await this.#read();
      if (!profiles.find(profile => profile.profileId === profileId)?.temporary) return;
      await rm(join(this.#directory, 'profile-data', browserProfileId(profileId)), { recursive: true, force: true });
      await this.#save(profiles.filter(profile => profile.profileId !== profileId));
    });
  }
  async dataDirectory(profileId: string) {
    await this.require(profileId);
    // Separate from the historical Workspace-hashed profiles. Never adopt those identities silently.
    const parent = join(this.#directory, 'profile-data');
    await privateDirectory(parent);
    return join(parent, profileId);
  }
}
