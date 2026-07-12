const isLoopbackOrigin = (origin: string) => {
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
};

const isPrivateIpv4Host = (host: string) => {
  const parts = host.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;

  const [first, second] = parts;
  return first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254);
};

const isLocalNetworkOrigin = (origin: string) => {
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      (isPrivateIpv4Host(url.hostname) || url.hostname.endsWith('.local'));
  } catch {
    return false;
  }
};

export const isAllowedCorsOrigin = (origin: string, configuredOrigins: ReadonlySet<string>) =>
  configuredOrigins.has(origin) ||
  origin === 'capacitor://localhost' ||
  isLoopbackOrigin(origin) ||
  isLocalNetworkOrigin(origin);
