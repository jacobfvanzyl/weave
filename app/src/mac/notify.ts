// A notification the Mac shows for something other than a thread (`shell.ts` has those): what a
// program in a terminal asked to say (OSC 9, OSC 777), while the app isn't in front.
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';

let allowed: boolean | undefined;

export function macNotify({ title, body }: { title: string; body: string }) {
  // In front, the terminal's Block says it.
  if (document.hasFocus()) return;
  void (async () => {
    allowed ??= await isPermissionGranted() || await requestPermission() === 'granted';
    if (allowed) sendNotification({ title, body });
  })().catch(() => {});
}
