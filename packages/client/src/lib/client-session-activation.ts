import { getClientAppStorageKey } from './client-app';
import {
  claimLegacyClientSessionStorage,
  type ClientSessionIdentity,
  getClientSessionStorageKey,
  setActiveClientSessionIdentity,
} from './client-session';
import { activateAppShellSession } from '../stores/app-shell-store';
import { resetChatClientSession, useChatStore } from '../stores/chat-store';
import { activateClientSessionViewStore, useClientSessionViewStore } from '../stores/client-session-view-store';
import { activateEditorTabSession } from '../stores/editor-tab-store';
import { activateTerminalSession } from '../stores/terminal-store';
import { activateWorkspaceSurfaceSession } from '../stores/workspace-surface-store';

let activationEpoch = 0;
let activationQueue = Promise.resolve();
let didSeedLegacyChatViewState = false;

const seedLegacyChatViewState = () => {
  if (didSeedLegacyChatViewState) return;
  didSeedLegacyChatViewState = true;
  const session = useClientSessionViewStore.getState();
  const chat = useChatStore.getState();
  if (Object.keys(session.toolActivityCollapsed).length === 0) {
    for (const [groupId, collapsed] of Object.entries(chat.toolActivityCollapsed)) {
      session.setToolActivityCollapsed(groupId, collapsed);
    }
  }
};

export const activateClientSessionStores = async (identity: ClientSessionIdentity) => {
  const requestedEpoch = (activationEpoch += 1);
  let didActivate = false;

  activationQueue = activationQueue.then(async () => {
    if (requestedEpoch !== activationEpoch) return;
    setActiveClientSessionIdentity(identity);

    const sessionViewKey = getClientSessionStorageKey('weave-session-view', identity);
    claimLegacyClientSessionStorage(sessionViewKey, [getClientAppStorageKey('weave-session-view')]);

    await Promise.all([
      activateWorkspaceSurfaceSession(identity),
      activateEditorTabSession(identity),
      activateAppShellSession(identity),
      activateTerminalSession(identity),
      activateClientSessionViewStore(identity),
    ]);

    if (requestedEpoch !== activationEpoch) return;
    seedLegacyChatViewState();
    resetChatClientSession();
    didActivate = true;
  });

  await activationQueue;
  return didActivate;
};
