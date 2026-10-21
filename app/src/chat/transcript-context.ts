import { createContext, useContext } from 'react';
import type { AcpTranscript } from './acp-transcript';

export type TranscriptContextValue = {
  /** The session's own transcript, which names its subagents and holds its terminals. */
  root?: AcpTranscript;
  /** Shows a subagent's own transcript instead. */
  openSubagent?(sessionId: string): void;
};

/** What a transcript's entries need from the session around them, whichever transcript they're in. */
export const TranscriptContext = createContext<TranscriptContextValue>({});

export const useTranscriptContext = () => useContext(TranscriptContext);
