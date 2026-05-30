type EnvMap = Record<string, string | undefined>;

type WeaveClientDefineOptions = {
  appEnv: EnvMap;
  shellEnv: EnvMap;
  workspaceEnv: EnvMap;
};

const firstNonEmpty = (...values: Array<string | undefined>) =>
  values.map(value => value?.trim()).find((value): value is string => Boolean(value));

const firstTokenFromAuthTokens = (rawTokens: string | undefined) => {
  if (!rawTokens?.trim()) return undefined;

  try {
    const parsed = JSON.parse(rawTokens) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return Object.keys(parsed).find(token => Boolean(token.trim()));
  } catch {
    return undefined;
  }
};

const getServerAuthToken = (env: EnvMap) =>
  firstNonEmpty(env.WEAVE_AUTH_TOKEN, firstTokenFromAuthTokens(env.WEAVE_AUTH_TOKENS));

export const resolveWeaveClientAuthToken = ({ appEnv, shellEnv, workspaceEnv }: WeaveClientDefineOptions) =>
  firstNonEmpty(
    getServerAuthToken(shellEnv),
    getServerAuthToken(workspaceEnv),
    getServerAuthToken(appEnv),
    shellEnv.VITE_WEAVE_AUTH_TOKEN,
    appEnv.VITE_WEAVE_AUTH_TOKEN,
    workspaceEnv.VITE_WEAVE_AUTH_TOKEN,
  );

export const createWeaveClientDefines = (options: WeaveClientDefineOptions) => ({
  __WEAVE_AUTH_TOKEN__: JSON.stringify(resolveWeaveClientAuthToken(options) ?? null),
});
