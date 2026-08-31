export type AlphaBrowserLocation =
  | { kind: 'empty' }
  | { kind: 'navigate'; url: string }
  | { kind: 'external'; url: string }
  | { kind: 'invalid'; message: string };

const invalidLocation = (): AlphaBrowserLocation => ({
  kind: 'invalid',
  message: 'Enter a valid web address or Google search.',
});

const explicitScheme = /^[a-z][a-z\d+.-]*:/i;
const knownExternalScheme = /^(?:mailto|tel|sms|facetime|facetime-audio|maps|itms-apps):/i;

const plausibleHostname = (hostname: string) =>
  hostname === 'localhost' ||
  hostname.includes('.') ||
  /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) ||
  hostname.includes(':');

export function resolveAlphaBrowserLocation(input: string): AlphaBrowserLocation {
  const value = input.trim();
  if (!value) return { kind: 'empty' };

  const hostWithPort = /^[a-z\d.-]+:\d+(?:[/?#]|$)/i.test(value);
  if (explicitScheme.test(value) && (!hostWithPort || knownExternalScheme.test(value))) {
    let destination: URL;
    try {
      destination = new URL(value);
    } catch {
      return invalidLocation();
    }
    if (destination.protocol === 'http:' || destination.protocol === 'https:') {
      return destination.hostname ? { kind: 'navigate', url: destination.href } : invalidLocation();
    }
    return { kind: 'external', url: destination.href };
  }

  if (!/\s/.test(value)) {
    try {
      const destination = new URL(`https://${value}`);
      if (hostWithPort || plausibleHostname(destination.hostname)) {
        return { kind: 'navigate', url: destination.href };
      }
    } catch {
      // Fall through to Google Search.
    }
  }

  return {
    kind: 'navigate',
    url: `https://www.google.com/search?q=${encodeURIComponent(value)}`,
  };
}
