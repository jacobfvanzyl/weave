import type { CreateElicitationResponse } from '@/host/protocol';
import type { RequestStatus } from './acp-transcript';

/** What a card says once its request stopped waiting other than by this device's answer, as the TUI says it. */
export const requestEndText: Record<Exclude<RequestStatus, 'pending' | 'answered'>, string> = {
  elsewhere: 'Answered on another client',
  cancelled: 'The turn ended before it was answered',
  withdrawn: 'The agent withdrew its request',
  ended: 'No longer waiting',
};

/** What this device answered an elicitation. */
export const elicitationAnswerText = (response: CreateElicitationResponse | undefined, url: boolean) => {
  switch (response?.action) {
    case 'accept':
      return url ? 'You opened it in your browser' : 'You sent your answers';
    case 'decline':
      return 'You declined';
    case 'cancel':
      return 'You cancelled';
    default:
      return 'Answered';
  }
};

/** A client tool call's runner, to start a sentence: "the TUI" is "The TUI". */
export const sentenceStart = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * What a URL elicitation's page is: the host it opens, and what to beware of, as the TUI warns.
 * Only web pages open from the app; a URL of another scheme has no `host` here.
 */
export function urlCheck(url: string): { host?: string; warnings: string[] } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { warnings: ['This is not a valid URL.'] };
  }
  const scheme = parsed.protocol.replace(/:$/, '');
  if (scheme !== 'https' && scheme !== 'http') {
    return { warnings: [`Only web pages open from here; this uses ${scheme}.`] };
  }
  const warnings: string[] = [];
  if (scheme !== 'https') warnings.push(`Not encrypted: uses ${scheme}.`);
  const host = parsed.hostname;
  // URL gives an internationalized host in Punycode.
  if (host.split('.').some((label) => label.startsWith('xn--'))) warnings.push('The host uses Punycode; it may imitate another site.');
  if (/^\d+(\.\d+){3}$/.test(host) || host.startsWith('[')) warnings.push('The host is a bare IP address.');
  if (parsed.username || parsed.password) warnings.push('The URL embeds credentials before the host.');
  return { host, warnings };
}
