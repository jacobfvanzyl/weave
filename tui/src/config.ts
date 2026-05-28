import type { ParsedArgs, TuiConfig } from './types.ts';

export const homeDir = Deno.env.get('HOME') ?? '.';
export const configHomeDir = Deno.env.get('XDG_CONFIG_HOME') ?? `${homeDir}/.config`;
export const defaultConfigPath = `${configHomeDir}/weave/config.json`;
export const defaultServerUrl = 'http://localhost:4111';

export const parseArgs = (args: string[]): ParsedArgs => {
  const [command, ...rest] = args;
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) continue;

    const [key, inlineValue] = arg.slice(2).split('=', 2);
    if (inlineValue !== undefined) {
      flags[key] = inlineValue;
      continue;
    }

    const next = rest[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
      continue;
    }

    flags[key] = true;
  }

  return { command, flags };
};

export const stringFlag = (flags: Record<string, string | boolean>, key: string) => {
  const value = flags[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

export const readConfig = async (path: string): Promise<TuiConfig> => {
  const content = await Deno.readTextFile(path).catch(error => {
    if (error instanceof Deno.errors.NotFound) return '{}';
    throw error;
  });
  return JSON.parse(content) as TuiConfig;
};

const ensureParentDir = async (path: string) => {
  const slashIndex = path.lastIndexOf('/');
  if (slashIndex <= 0) return;
  await Deno.mkdir(path.slice(0, slashIndex), { recursive: true });
};

export const writeConfig = async (path: string, config: TuiConfig) => {
  await ensureParentDir(path);
  await Deno.writeTextFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
};
