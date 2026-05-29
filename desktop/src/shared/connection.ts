export const DEFAULT_MASTRA_URL = 'http://localhost:4111';

const hasProtocol = (value: string) => /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(value);

export const normalizeMastraUrl = (input?: string) => {
  const trimmed = input?.trim() || DEFAULT_MASTRA_URL;
  const withProtocol = hasProtocol(trimmed) ? trimmed : `http://${trimmed}`;
  const url = new URL(withProtocol);

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Weave server URL must use http or https.');
  }

  if (url.username || url.password) {
    throw new Error('Weave server URL must not include credentials.');
  }

  url.hash = '';
  url.search = '';

  return url.toString().replace(/\/+$/, '');
};

export const getServerOrigin = (mastraUrl: string) => new URL(normalizeMastraUrl(mastraUrl)).origin;

export const isHttpUrl = (input: string) => {
  try {
    const url = new URL(input);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

export const parseDesktopConnectionInput = (input: unknown) => {
  if (!input || typeof input !== 'object') {
    throw new Error('Connection settings must be an object.');
  }

  const record = input as Record<string, unknown>;
  if (typeof record.mastraUrl !== 'string') {
    throw new Error('Connection settings must include a server URL.');
  }

  if (
    Object.hasOwn(record, 'authToken') &&
    record.authToken !== null &&
    record.authToken !== undefined &&
    typeof record.authToken !== 'string'
  ) {
    throw new Error('Connection auth token must be a string or null.');
  }

  return {
    mastraUrl: record.mastraUrl,
    ...(Object.hasOwn(record, 'authToken') ? { authToken: record.authToken as string | null | undefined } : {}),
  };
};
