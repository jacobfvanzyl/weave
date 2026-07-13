import { assertEquals, assertRejects, assertStringIncludes } from 'jsr:@std/assert@1.0.19';
import {
  assertToolAllowed,
  cleanupSandboxInvocation,
  normalizeExecutionProfile,
  prepareSandboxInvocation,
  seatbeltProfile,
} from './execution-policy.ts';

Deno.test('Portal execution policy defaults to workspace and denies observe mutations', async () => {
  assertEquals(normalizeExecutionProfile(undefined), 'workspace');
  assertEquals(normalizeExecutionProfile('host'), 'host');
  assertToolAllowed('read', 'observe');
  await assertRejects(async () => assertToolAllowed('bash', 'observe'), Error, 'denied');
});

Deno.test('Seatbelt profile grants writes only to workspace and temporary roots', () => {
  const profile = seatbeltProfile('/repo/work tree', '/tmp/weave');
  assertStringIncludes(profile, '(deny default)');
  assertStringIncludes(profile, '(subpath "/repo/work tree")');
  assertStringIncludes(profile, '(subpath "/tmp/weave")');
  assertEquals(profile.includes('(allow network'), false);
});

Deno.test('Workspace sandbox invocation clears inherited environment and denies network', async () => {
  const invocation = await prepareSandboxInvocation({
    profile: 'workspace',
    workspaceRoot: '/tmp/workspace',
    cwd: '/tmp/workspace',
    shellCommand: 'pwd',
    os: 'darwin',
  });
  try {
    assertEquals(invocation.command, '/usr/bin/sandbox-exec');
    assertEquals(invocation.clearEnv, true);
    assertEquals(invocation.network, 'denied');
    assertEquals(invocation.env?.WEAVE_OWNER_TOKEN, undefined);
  } finally {
    await cleanupSandboxInvocation(invocation);
  }
});

const runWorkspaceCommand = async (workspaceRoot: string, cwd: string, shellCommand: string) => {
  const invocation = await prepareSandboxInvocation({ profile: 'workspace', workspaceRoot, cwd, shellCommand });
  try {
    return await new Deno.Command(invocation.command, {
      cwd: invocation.cwd,
      args: invocation.args,
      env: invocation.env,
      clearEnv: invocation.clearEnv,
      stdout: 'piped',
      stderr: 'piped',
    }).output();
  } finally {
    await cleanupSandboxInvocation(invocation);
  }
};

Deno.test('Workspace sandbox blocks absolute, parent, symlink, child-process, secret, and network escapes', async () => {
  if (Deno.build.os !== 'darwin' && Deno.build.os !== 'linux') return;
  const workspace = await Deno.realPath(await Deno.makeTempDir({ prefix: 'weave-sandbox-workspace-' }));
  const outside = await Deno.realPath(await Deno.makeTempDir({ prefix: 'weave-sandbox-outside-' }));
  const outsideName = outside.split('/').at(-1)!;
  const previousSecret = Deno.env.get('WEAVE_SANDBOX_TEST_SECRET');
  try {
    Deno.env.set('WEAVE_SANDBOX_TEST_SECRET', 'must-not-leak');
    await Deno.writeTextFile(`${outside}/secret.txt`, 'host-secret-must-not-leak');
    await Deno.symlink(outside, `${workspace}/outside-link`);
    for (
      const command of [
        `printf escaped > '${outside}/absolute.txt'`,
        `printf escaped > '../${outsideName}/parent.txt'`,
        'printf escaped > outside-link/symlink.txt',
        `sh -c "printf escaped > '${outside}/child.txt'"`,
      ]
    ) {
      const output = await runWorkspaceCommand(workspace, workspace, command);
      assertEquals(output.success, false, command);
    }
    assertEquals(await Deno.stat(`${outside}/absolute.txt`).catch(() => undefined), undefined);
    assertEquals(await Deno.stat(`${outside}/parent.txt`).catch(() => undefined), undefined);
    assertEquals(await Deno.stat(`${outside}/symlink.txt`).catch(() => undefined), undefined);
    assertEquals(await Deno.stat(`${outside}/child.txt`).catch(() => undefined), undefined);

    const secretFile = await runWorkspaceCommand(workspace, workspace, `cat '${outside}/secret.txt'`);
    assertEquals(secretFile.success, false);
    assertEquals(new TextDecoder().decode(secretFile.stdout).includes('host-secret-must-not-leak'), false);
    const secret = await runWorkspaceCommand(workspace, workspace, 'test -z "$WEAVE_SANDBOX_TEST_SECRET"');
    assertEquals(secret.success, true);
    const network = await runWorkspaceCommand(workspace, workspace, '/usr/bin/curl --max-time 2 https://example.com');
    assertEquals(network.success, false);
    const toolchainRead = await runWorkspaceCommand(workspace, workspace, 'deno --version >/dev/null');
    assertEquals(toolchainRead.success, true);
    const localWrite = await runWorkspaceCommand(workspace, workspace, 'printf allowed > local.txt');
    assertEquals(localWrite.success, true);
    assertEquals(await Deno.readTextFile(`${workspace}/local.txt`), 'allowed');
  } finally {
    if (previousSecret === undefined) Deno.env.delete('WEAVE_SANDBOX_TEST_SECRET');
    else Deno.env.set('WEAVE_SANDBOX_TEST_SECRET', previousSecret);
    await Deno.remove(workspace, { recursive: true }).catch(() => undefined);
    await Deno.remove(outside, { recursive: true }).catch(() => undefined);
  }
});
