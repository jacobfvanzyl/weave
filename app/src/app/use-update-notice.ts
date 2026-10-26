import { useState } from 'react';
import type { AgentUpdateNotice } from './app-controller';

const STORAGE_KEY = 'weave.dismissedUpdates';

/**
 * What a dismissal hides: the notice as it was. A newer release, or the Host launching a version
 * the session can move to, shows it again.
 */
const shown = ({ latest, available }: AgentUpdateNotice) => available ? `${latest} ${available}` : latest;

/** The notices dismissed on this device, by session key, from the web view's storage. */
function stored(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? '{}');
    if (typeof parsed !== 'object' || parsed === null) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, notice]) => typeof notice === 'string'));
  } catch {
    return {};
  }
}

/** Session `key`'s update notice unless the person dismissed it on this device, and what dismisses it. */
export function useUpdateNotice(key: string, update?: AgentUpdateNotice) {
  const [dismissed, setDismissed] = useState(stored);
  const notice = update && dismissed[key] !== shown(update) ? update : undefined;
  const dismiss = () => {
    if (!update) return;
    const next = { ...stored(), [key]: shown(update) };
    setDismissed(next);
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Full or unavailable: the notice stays dismissed until the app quits.
    }
  };
  return [notice, dismiss] as const;
}
