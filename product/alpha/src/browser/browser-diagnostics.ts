/** Acceptance-only opt-in. Numeric timings/counts, never keys, URLs or page text. */
export type BrowserInputSample = { capturedAt: number; queueMs: number; rpcMs: number; pending: number; wheel: boolean; ok: boolean };
let samples: BrowserInputSample[] | undefined;
export function startBrowserDiagnostics() { samples = []; }
export function browserDiagnostics() { return samples; }
export function recordBrowserInput(sample: BrowserInputSample) { if (samples && samples.length < 20_000) samples.push(sample); }
