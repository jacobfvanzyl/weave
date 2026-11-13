// @vitest-environment node
/// <reference types="bun" />
// Projects from the app (WVE-220), against a dev Dispatcher and two dev Hosts that joined it: the
// store asks a Host where a directory lies in git, registers it as a Project, offers a clone on
// the other Host to it, and renames, shrinks and removes it, the list following each time. A
// Session's first terminal starts in a directory that isn't on screen. Skipped unless the debug
// `weave` and fake agent are built.
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sessionKey } from '@/app/app-controller';
import { projectAt, projectLocation, projectsOfRepository } from '@/session/sessions';
import type { HostStore } from './host-store';
import { devStore, startDevDispatcher, type DevDispatcher } from './testing/dev-dispatcher';
import { devHostAvailable, devHostHasTerminals, startDevHost, type DevHost } from './testing/dev-host';

const waitFor = async <T,>(find: () => T | undefined | false, what: string, ms = 30_000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = find();
    if (found !== undefined && found !== false) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await Bun.sleep(25);
  }
};

/** A repository with a remote and one commit, beside a dev Host's directory. */
const clone = async (host: DevHost, name: string) => {
  const path = join(realpathSync(join(host.cwd, '..')), name);
  mkdirSync(join(path, 'docs'), { recursive: true });
  const git = async (...args: string[]) => {
    const run = Bun.spawn(['git', '-C', path, '-c', 'user.name=weave', '-c', 'user.email=weave@example.invalid', ...args], { stdout: 'ignore', stderr: 'pipe' });
    if (await run.exited !== 0) throw new Error(`git ${args.join(' ')}: ${await new Response(run.stderr).text()}`);
  };
  await git('init', '--quiet', '--initial-branch=main');
  await git('remote', 'add', 'origin', 'https://github.com/example/odin.git');
  await git('commit', '--quiet', '--allow-empty', '-m', 'start');
  return path;
};

describe.skipIf(!devHostAvailable())('Projects in the app', () => {
  let dispatcher: DevDispatcher;
  let first: DevHost;
  let second: DevHost;
  let studio: string;
  let homelab: string;
  let pad: HostStore;

  beforeAll(async () => {
    [dispatcher, first, second] = await Promise.all([startDevDispatcher(), startDevHost(), startDevHost()]);
    studio = await dispatcher.join(first, 'studio');
    homelab = await dispatcher.join(second, 'homelab');
    ({ store: pad } = devStore({ deviceName: 'Test iPad' }));
    await pad.start();
    await pad.actions.pairDispatcher({ url: dispatcher.url, code: await dispatcher.offer() });
    await waitFor(() => pad.snapshot().hosts.length === 2 && pad.snapshot().hosts.every(({ status }) => status === 'connected'), 'both Hosts to connect');
  }, 60_000);

  afterAll(async () => {
    pad?.stop();
    await Promise.all([first?.stop(), second?.stop()]);
    await dispatcher?.stop();
  });

  const projects = () => pad.snapshot().projects ?? [];

  it('adds a repository as a Project, a clone on another Host to it, and renames, shrinks and removes it', async () => {
    expect(pad.snapshot().canManageProjects).toBe(true);
    const [here, there] = await Promise.all([clone(first, 'odin'), clone(second, 'odin-clone')]);

    // From a directory inside it: the Project is the repository, known by its remote.
    const location = projectLocation(studio, join(here, 'docs'), await pad.actions.listWorktrees({ hostId: studio, path: join(here, 'docs') }));
    expect(location).toEqual({ hostId: studio, path: here, kind: 'git', remote: 'github.com/example/odin' });
    const added = await pad.actions.addProject?.({ name: 'odin', location });
    expect(added).toMatchObject({ name: 'odin', kind: 'git', remote: 'github.com/example/odin', locations: [{ hostId: studio, path: here }] });
    expect(projectAt(projects(), location)?.id).toBe(added?.id);
    // The Dispatcher refuses in its own words.
    await expect(pad.actions.addProject?.({ name: 'ODIN', location: projectLocation(studio, first.cwd) })).rejects.toThrow(/odin/i);

    // The clone on the other Host is offered to it, and joins it.
    const other = projectLocation(homelab, there, await pad.actions.listWorktrees({ hostId: homelab, path: there }));
    expect(projectsOfRepository(projects(), other).map(({ id }) => id)).toEqual([added?.id]);
    const joined = await pad.actions.updateProject?.(added!.id, { add: other });
    expect(joined?.locations).toEqual([{ hostId: studio, path: here }, { hostId: homelab, path: there }]);
    expect(projectsOfRepository(projects(), other)).toEqual([]);

    // A directory outside a repository is a directory Project, which the repository's clone can't join.
    const plain = await pad.actions.addProject?.({ name: 'work', location: projectLocation(studio, first.cwd, await pad.actions.listWorktrees({ hostId: studio, path: first.cwd })) });
    expect(plain).toMatchObject({ kind: 'directory', locations: [{ hostId: studio, path: first.cwd }] });
    await expect(pad.actions.updateProject?.(plain!.id, { add: other })).rejects.toThrow();

    const renamed = await pad.actions.updateProject?.(added!.id, { name: 'loom', removeHost: studio });
    expect(renamed).toMatchObject({ name: 'loom', locations: [{ hostId: homelab, path: there }] });
    expect(projects().map(({ name }) => name)).toEqual(['loom', 'work']);

    // Another client's list agrees: the Dispatcher kept it all.
    const { projects: kept } = await (await dispatcher.local()).request('projects/list', {});
    expect(kept.map(({ name, locations }) => [name, locations?.length])).toEqual([['loom', 1], ['work', 1]]);

    await pad.actions.removeProject?.(added!.id);
    await pad.actions.removeProject?.(plain!.id);
    expect(projects()).toEqual([]);
    expect((await (await dispatcher.local()).request('projects/list', {})).projects).toEqual([]);
  }, 60_000);

  it.skipIf(!devHostHasTerminals())('starts a terminal in a directory with no Session on screen, which its Session then lists', async () => {
    const directory = realpathSync(first.cwd);
    const started = await pad.actions.startTerminal?.({ hostId: studio, directory });
    expect(started?.sessionKey).toBe(sessionKey(studio, directory));
    pad.actions.selectSession?.(started!.sessionKey);
    const listed = await waitFor(() => pad.snapshot().session?.terminals?.find(({ id }) => id === started?.id), 'the Session to list its terminal');
    expect(listed.scope).toBe(directory);
    await pad.actions.closeTerminal(started!.id);
  }, 60_000);
});
