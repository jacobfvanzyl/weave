import { assertEquals } from 'jsr:@std/assert@1.0.19';
import {
  discoverGlobalWeaveContext,
  discoverProjectWeaveContext,
  listGitBranchesTool,
  type ResolvedPortalConfig,
} from './main.ts';
import { resolveWindowStreamConfig } from './window.ts';

const portalConfig: ResolvedPortalConfig = {
  portalId: 'portal_test',
  portalToken: 'token',
  httpServerUrl: 'http://localhost:4111',
  wsServerUrl: 'ws://localhost:4112',
  name: 'Test Portal',
  windowStream: resolveWindowStreamConfig(),
  mounts: [],
  roots: [],
};

const write = async (path: string, content: string) => {
  await Deno.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await Deno.writeTextFile(path, content);
};

const runGit = async (cwd: string, args: string[]) => {
  const result = await new Deno.Command('git', { cwd, args, stdout: 'null', stderr: 'null' }).output();
  if (!result.success) throw new Error(`git ${args.join(' ')} failed`);
};

Deno.test('Portal discovery reads ~/.config/weave profiles, prompts, skills, MCP, and config', async () => {
  const previousHome = Deno.env.get('HOME');
  const home = await Deno.makeTempDir({ prefix: 'weave-global-context-' });
  try {
    Deno.env.set('HOME', home);
    await write(`${home}/.config/weave/weave.config.json`, '{"defaultProfileId":"default"}');
    await write(`${home}/.config/weave/mcp.json`, '{"servers":{}}');
    await write(`${home}/.config/weave/profiles/default.md`, '# Default\n');
    await write(`${home}/.config/weave/prompts/ship.md`, '# Ship\n');
    await write(`${home}/.config/weave/skills/release/SKILL.md`, '---\nname: release\ndescription: Release\n---\n');
    await write(`${home}/.config/weave/skills/release/references/notes.md`, 'not collected');

    const result = await discoverGlobalWeaveContext();
    assertEquals(result.basePath, `${home}/.config/weave`);
    assertEquals(result.files.map((file) => `${file.kind}:${file.path}`).sort(), [
      'config:.config/weave/weave.config.json',
      'mcp:.config/weave/mcp.json',
      'profile:.config/weave/profiles/default.md',
      'prompt:.config/weave/prompts/ship.md',
      'skill:.config/weave/skills/release/SKILL.md',
    ]);
  } finally {
    if (previousHome === undefined) Deno.env.delete('HOME');
    else Deno.env.set('HOME', previousHome);
    await Deno.remove(home, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('Portal discovery returns AGENTS.md and .weave files from git root to workspace path', async () => {
  const repo = await Deno.realPath(await Deno.makeTempDir({ prefix: 'weave-project-context-' }));
  const workspace = `${repo}/packages/app`;
  try {
    await Deno.mkdir(workspace, { recursive: true });
    await runGit(repo, ['init']);

    await write(`${repo}/AGENTS.md`, 'root agents');
    await write(`${repo}/packages/AGENTS.md`, 'packages agents');
    await write(`${workspace}/AGENTS.md`, 'app agents');
    await write(`${repo}/.weave/prompts/root.md`, '# Root prompt\n');
    await write(`${repo}/packages/.weave/prompts/packages.md`, '# Packages prompt\n');
    await write(`${workspace}/.weave/mcp.json`, '{"servers":{}}');
    await write(`${workspace}/.weave/skills/app/SKILL.md`, '---\nname: app\ndescription: App\n---\n');
    await write(`${workspace}/.weave/skills/app/references/notes.md`, 'not collected');

    const result = await discoverProjectWeaveContext(portalConfig, { workspacePath: workspace });
    assertEquals(result.basePath, repo);
    assertEquals(result.workspacePath, workspace);
    assertEquals(result.files.map((file) => `${file.kind}:${file.path}`), [
      'agents:AGENTS.md',
      'agents:packages/AGENTS.md',
      'agents:packages/app/AGENTS.md',
      'prompt:.weave/prompts/root.md',
      'prompt:packages/.weave/prompts/packages.md',
      'mcp:packages/app/.weave/mcp.json',
      'skill:packages/app/.weave/skills/app/SKILL.md',
    ]);
  } finally {
    await Deno.remove(repo, { recursive: true }).catch(() => undefined);
  }
});

Deno.test('Portal branch listing normalizes local and origin branches', async () => {
  const repo = await Deno.realPath(await Deno.makeTempDir({ prefix: 'weave-branches-' }));
  try {
    await runGit(repo, ['init']);
    await runGit(repo, ['checkout', '-b', 'main']);
    await runGit(repo, ['config', 'user.email', 'portal-test@example.com']);
    await runGit(repo, ['config', 'user.name', 'Portal Test']);
    await write(`${repo}/README.md`, '# Test\n');
    await runGit(repo, ['add', 'README.md']);
    await runGit(repo, ['commit', '-m', 'initial']);
    await runGit(repo, ['branch', 'feature/local']);
    await runGit(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    await runGit(repo, ['update-ref', 'refs/remotes/origin/remote-only', 'HEAD']);
    await runGit(repo, ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);

    const result = await listGitBranchesTool(portalConfig, { workspacePath: repo });
    assertEquals(result, {
      ok: true,
      branches: [
        { name: 'main', ref: 'main', kind: 'local', current: true },
        { name: 'feature/local', ref: 'feature/local', kind: 'local', current: false },
        { name: 'remote-only', ref: 'origin/remote-only', kind: 'remote' },
      ],
    });
  } finally {
    await Deno.remove(repo, { recursive: true }).catch(() => undefined);
  }
});
