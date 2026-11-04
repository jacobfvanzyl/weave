import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppModel } from '@/app/app-controller';
import type { AcpTranscript } from '@/chat/acp-transcript';
import { NO_SURFACE, type SurfaceLink, type SurfaceStatus } from './surface-link';
import { showMessage, transcriptMessage, type SentTranscript, type SurfacePosition, type ToSurface } from './surface-messages';

/** The device's Surface, while it has a link to one. */
export type DeviceSurface = {
  status: SurfaceStatus;
  /** Where the Surface's thread is scrolled to, as it last said. */
  position?: SurfacePosition;
  /** Scrolls the Surface's thread to a fraction of the way down. */
  scroll(fraction: number): void;
  /** Scrolls the Surface's thread to its end and keeps it there. */
  follow(): void;
  setEnabled(enabled: boolean): void;
};

/** How long changes gather before they go to the Surface: a streaming reply changes many times a second. */
const GATHER_MS = 50;

/**
 * Keeps the Surface showing what the device has: the open thread, or the one last open, dimmed,
 * while the device shows its list. Only what changed goes, and everything again whenever the
 * Surface asks (`ready`), as it does on connecting.
 */
export function useSurface(model: AppModel, link: SurfaceLink | undefined): DeviceSurface | undefined {
  const [status, setStatus] = useState<SurfaceStatus>(NO_SURFACE);
  const [position, setPosition] = useState<SurfacePosition>();
  const [resend, setResend] = useState(0);
  const latest = useRef(model);
  latest.current = model;
  const last = useRef<{ key: string; transcript: AcpTranscript }>(undefined);
  if (model.session && !model.session.loading) last.current = { key: model.session.key, transcript: model.session.transcript };
  const sentShow = useRef<string>(undefined);
  const sentTranscript = useRef<SentTranscript>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!link) return;
    let live = true;
    // What the link says as it changes is newer than its first answer, which can come after.
    let heard = false;
    void link.status().then((next) => { if (live && !heard) setStatus(next); });
    const offStatus = link.onStatus((next) => {
      heard = true;
      setStatus(next);
    });
    const offMessage = link.onMessage((message) => {
      if (message.kind === 'ready') {
        sentShow.current = undefined;
        sentTranscript.current = undefined;
        setResend((count) => count + 1);
        return;
      }
      setPosition({ fraction: message.fraction, following: message.following, scrollable: message.scrollable });
    });
    return () => {
      live = false;
      offStatus();
      offMessage();
    };
  }, [link]);

  const shownKey = model.session?.key ?? last.current?.key;
  useEffect(() => setPosition(undefined), [shownKey]);

  useEffect(() => {
    if (!link || !status.connected) {
      sentShow.current = undefined;
      sentTranscript.current = undefined;
      return;
    }
    if (timer.current !== undefined) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      const current = latest.current;
      const show = showMessage(current, last.current?.key);
      const text = JSON.stringify(show);
      if (text !== sentShow.current) {
        sentShow.current = text;
        link.send(show);
      }
      const shown = last.current;
      if (!shown || show.thread?.loading) return;
      const message = transcriptMessage(shown.key, shown.transcript, sentTranscript.current);
      if (!message) return;
      sentTranscript.current = { key: shown.key, transcript: shown.transcript };
      link.send(message);
    }, GATHER_MS);
  }, [link, status.connected, model, resend]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const send = useCallback((message: ToSurface) => link?.send(message), [link]);
  const scroll = useCallback((fraction: number) => send({ kind: 'scroll', fraction }), [send]);
  const follow = useCallback(() => send({ kind: 'scroll', to: 'end' }), [send]);
  const setEnabled = useCallback((enabled: boolean) => link?.setEnabled(enabled), [link]);
  if (!link) return undefined;
  return { status, position, scroll, follow, setEnabled };
}
