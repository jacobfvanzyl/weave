// What the Mac's shell adds around the app (ADR 0032): its menu bar, built from the app's commands
// and their keys; notifications for threads that need the person or finished while the app isn't
// in front; and `weave://` links, which open a thread or offer a pairing.
import { useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getCurrent, onOpenUrl } from '@tauri-apps/plugin-deep-link';
import { isPermissionGranted, onAction, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import type { AppController, ThreadSummary } from '@/app/app-controller';
import { COMMAND_GROUPS, COMMANDS, type CommandSpec, isCommand, runCommand } from '@/app/commands';
import { requestOpenThread } from '@/app/open-thread';
import { pairingLink } from '@/host/storage';
import { ownThreads } from '@/session/sessions';
import { noticesFor, threadLink } from './notices';
import { inShell, onMac } from './routes';

/** Brings the window to the front, as a click on a notification or a link should. */
const front = async () => {
  const window = getCurrentWindow();
  await window.show().catch(() => {});
  await window.unminimize().catch(() => {});
  await window.setFocus().catch(() => {});
};

/** A command's key as the menu bar takes it: `CmdOrCtrl+Shift+D`. */
export const accelerator = (keys: string) => keys.split('+').map((part) => part === 'Mod' ? 'CmdOrCtrl' : part).join('+');

/** The app's commands as the menu bar lists them: a menu for each group, in the table's order. */
export const menuGroups = (commands: readonly CommandSpec[] = COMMANDS) => COMMAND_GROUPS.map((title) => ({
  title,
  items: commands.filter(({ group }) => group === title).map(({ id, title: name, keys }) => ({
    id,
    title: name,
    ...(keys ? { accelerator: accelerator(keys) } : {}),
  })),
}));

/** The menu bar's commands: it lists the app's, and choosing one, or pressing its key, runs it in the page. */
function useMenu() {
  useEffect(() => {
    if (!onMac()) return;
    void invoke('set_menu', { groups: menuGroups() }).catch(() => {});
    const listening = listen<string>('menu', ({ payload }) => {
      if (isCommand(payload)) runCommand(payload);
    });
    return () => { void listening.then((unlisten) => unlisten()).catch(() => {}); };
  }, []);
}

/** Notifies of threads that need the person, or finished, while the window isn't in front; a click shows the thread. */
function useNotifications(controller: AppController) {
  const before = useRef<readonly ThreadSummary[]>([]);
  const allowed = useRef<boolean | undefined>(undefined);
  // Only of threads in a Session, or a Bot's: the app says nothing of one started elsewhere.
  const { threads: listed, known, bots } = controller.model;
  const threads = useMemo(() => ownThreads({ threads: listed, known, bots }), [listed, known, bots]);
  useEffect(() => {
    if (!onMac()) return;
    const listening = onAction(({ actionId, notification }) => {
      const key = notification?.extra?.thread;
      if (actionId !== 'tap' || typeof key !== 'string') return;
      requestOpenThread(key);
      void front();
    });
    return () => { void listening.then((listener) => listener.unregister()).catch(() => {}); };
  }, []);
  useEffect(() => {
    const notices = noticesFor(before.current, threads);
    before.current = threads;
    if (!onMac() || notices.length === 0 || document.hasFocus()) return;
    void (async () => {
      allowed.current ??= await isPermissionGranted() || await requestPermission() === 'granted';
      if (!allowed.current) return;
      for (const notice of notices) sendNotification({ title: notice.title, body: notice.body, extra: { thread: notice.key } });
    })().catch(() => {});
  }, [threads]);
}

/** `weave://thread/…` shows the thread, in its Session; a pairing link is offered, as the Camera's is on the iPad. */
function useLinks() {
  const [offer, setOffer] = useState<{ url: string; code: string }>();
  useEffect(() => {
    // The iPad and iPhone open the app with a link too (WVE-221).
    if (!inShell()) return;
    const take = (urls: string[] | null) => {
      for (const url of urls ?? []) {
        const key = threadLink(url);
        if (key) {
          requestOpenThread(key);
          void front();
          continue;
        }
        const pairing = pairingLink(url);
        if (pairing) {
          setOffer(pairing);
          void front();
        }
      }
    };
    void getCurrent().then(take).catch(() => {});
    const listening = onOpenUrl(take);
    return () => { void listening.then((unlisten) => unlisten()).catch(() => {}); };
  }, []);
  return offer;
}

/** The shell around the app: the Mac's menu bar and notifications, and on every device in it the links that open it; nothing in a browser. A pairing link it was opened with, for the person to confirm. */
export function useMacShell(controller: AppController) {
  useMenu();
  useNotifications(controller);
  return useLinks();
}
