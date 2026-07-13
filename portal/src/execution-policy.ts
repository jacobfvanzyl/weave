export type ExecutionProfile = 'observe' | 'workspace' | 'host';

export type SandboxInvocation = {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  clearEnv?: boolean;
  cleanupPath?: string;
  sandboxed: boolean;
  network: 'denied' | 'host';
};

const observeDeniedTools = new Set([
  'write',
  'edit',
  'bash',
  'exec_start',
  'exec_write',
  'exec_stop',
  'portal.fs.write',
  'portal.fs.mkdir',
  'portal.fs.move',
  'portal.fs.delete',
  'portal.fs.upload',
  'portal.git.worktree.create',
  'portal.git.worktree.switch',
  'portal.git.worktree.remove',
  'portal.git.worktree.branch-cleanup',
  'portal.git.fetch',
  'portal.git.pull',
]);

export const normalizeExecutionProfile = (value: unknown): ExecutionProfile =>
  value === 'observe' || value === 'host' ? value : 'workspace';

export const assertToolAllowed = (tool: unknown, profile: ExecutionProfile) => {
  const name = typeof tool === 'string' ? tool : '';
  if (profile === 'observe' && observeDeniedTools.has(name)) {
    throw new Error(`Tool ${name || '<unknown>'} is denied by the observe execution profile.`);
  }
};

const escapedSeatbeltPath = (path: string) => path.replaceAll('\\', '\\\\').replaceAll('"', '\\"');

const systemReadRoots = [
  '/System',
  '/usr',
  '/bin',
  '/sbin',
  '/Library',
  '/opt/homebrew',
  '/nix/store',
  '/private/etc',
  '/private/var/db',
  '/private/var/select',
];

const userToolchainRoots = (home: string | undefined) =>
  home
    ? ['.deno', '.bun', '.nvm', '.cargo', '.rustup', '.local', 'Library/Caches/deno', 'Library/pnpm']
      .map((path) => `${home}/${path}`)
    : [];

export const seatbeltProfile = (workspaceRoot: string, temporaryRoot: string, toolchainRoots: string[] = []) => {
  const readRoots = [...new Set([workspaceRoot, temporaryRoot, ...systemReadRoots, ...toolchainRoots])];
  const readRules = readRoots.map((path) => `  (subpath "${escapedSeatbeltPath(path)}")`).join('\n');
  return `
(version 1)
(deny default)
(allow process*)
(allow signal)
(allow sysctl-read)
(allow mach-lookup)
(allow ipc-posix-shm)
(allow file-read-metadata)
(allow file-read-data
${readRules}
  (literal "/")
  (literal "/dev/null")
  (literal "/dev/tty")
  (literal "/dev/urandom"))
(allow file-write*
  (subpath "${escapedSeatbeltPath(workspaceRoot)}")
  (subpath "${escapedSeatbeltPath(temporaryRoot)}")
  (literal "/dev/null")
  (literal "/dev/tty")
  (literal "/dev/dtracehelper"))
`.trim();
};

const existingDirectories = async (paths: string[]) => {
  const existing: string[] = [];
  for (const path of paths) {
    if ((await Deno.stat(path).catch(() => undefined))?.isDirectory) existing.push(path);
  }
  return existing;
};

const bindDestinationParents = (path: string, maskedRoot: string) => {
  const result: string[] = [];
  let parent = path.slice(0, path.lastIndexOf('/'));
  while (parent.startsWith(`${maskedRoot}/`) && parent !== maskedRoot) {
    result.unshift(parent);
    parent = parent.slice(0, parent.lastIndexOf('/'));
  }
  return result.flatMap((directory) => ['--dir', directory]);
};

const sandboxEnvironment = (temporaryRoot: string) => {
  const source = Deno.env.toObject();
  return {
    PATH: source.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: temporaryRoot,
    TMPDIR: temporaryRoot,
    LANG: source.LANG ?? 'C.UTF-8',
    LC_ALL: source.LC_ALL ?? source.LANG ?? 'C.UTF-8',
    TERM: source.TERM ?? 'dumb',
    CI: source.CI ?? '1',
    NO_COLOR: source.NO_COLOR ?? '1',
  };
};

export const prepareSandboxInvocation = async (input: {
  profile: ExecutionProfile;
  workspaceRoot: string;
  cwd: string;
  shellCommand: string;
  os?: typeof Deno.build.os;
}): Promise<SandboxInvocation> => {
  if (input.profile === 'observe') throw new Error('Shell execution is denied by the observe execution profile.');
  if (input.profile === 'host') {
    return {
      command: 'bash',
      args: ['-lc', input.shellCommand],
      cwd: input.cwd,
      sandboxed: false,
      network: 'host',
    };
  }

  const temporaryRoot = await Deno.realPath(await Deno.makeTempDir({ prefix: 'weave-agent-sandbox-' }));
  const env = sandboxEnvironment(temporaryRoot);
  const sourceEnvironment = Deno.env.toObject();
  const toolchainRoots = await existingDirectories(userToolchainRoots(sourceEnvironment.HOME));
  const os = input.os ?? Deno.build.os;
  if (os === 'darwin') {
    return {
      command: '/usr/bin/sandbox-exec',
      args: [
        '-p',
        seatbeltProfile(input.workspaceRoot, temporaryRoot, toolchainRoots),
        'bash',
        '-lc',
        input.shellCommand,
      ],
      cwd: input.cwd,
      env,
      clearEnv: true,
      cleanupPath: temporaryRoot,
      sandboxed: true,
      network: 'denied',
    };
  }
  if (os === 'linux') {
    const home = sourceEnvironment.HOME;
    const maskedRoots = [
      '/tmp',
      '/var/tmp',
      ...(home === '/root' ? ['/root'] : home?.startsWith('/home/') ? ['/home'] : []),
    ];
    const writableRoots = [input.workspaceRoot, temporaryRoot];
    const restoredReadRoots = toolchainRoots.filter((path) => !writableRoots.some((root) => path.startsWith(root)));
    const overlayArgs = maskedRoots.flatMap((path) => ['--tmpfs', path]);
    const parentArgs = [...writableRoots, ...restoredReadRoots].flatMap((path) => {
      const maskedRoot = maskedRoots.find((root) => path === root || path.startsWith(`${root}/`));
      return maskedRoot ? bindDestinationParents(path, maskedRoot) : [];
    });
    const toolchainArgs = restoredReadRoots.flatMap((path) => ['--ro-bind', path, path]);
    return {
      command: 'bwrap',
      args: [
        '--die-with-parent',
        '--new-session',
        '--unshare-net',
        '--ro-bind',
        '/',
        '/',
        ...overlayArgs,
        ...parentArgs,
        ...toolchainArgs,
        '--bind',
        input.workspaceRoot,
        input.workspaceRoot,
        '--bind',
        temporaryRoot,
        temporaryRoot,
        '--chdir',
        input.cwd,
        'bash',
        '-lc',
        input.shellCommand,
      ],
      cwd: input.cwd,
      env,
      clearEnv: true,
      cleanupPath: temporaryRoot,
      sandboxed: true,
      network: 'denied',
    };
  }

  await Deno.remove(temporaryRoot, { recursive: true }).catch(() => undefined);
  throw new Error(`Workspace sandboxing is not supported on ${os}; choose the host profile explicitly.`);
};

export const cleanupSandboxInvocation = async (invocation: SandboxInvocation) => {
  if (invocation.cleanupPath) await Deno.remove(invocation.cleanupPath, { recursive: true }).catch(() => undefined);
};
