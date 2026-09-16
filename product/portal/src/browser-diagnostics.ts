/** Opt-in bounded timing evidence. No credentials, identifiers or input contents. */
export const browserDiagnostics: { phase: string; at: number; ms: number; bytes?: number; bufferedBytes?: number }[] | undefined = process.env.WEAVE_BROWSER_DIAGNOSTICS === '1' ? [] : undefined;
export function recordBrowserTiming(phase: string, start: number) {
  if (browserDiagnostics && browserDiagnostics.length < 100_000) browserDiagnostics.push({ phase, at: Date.now(), ms: performance.now() - start });
}

export function recordBrowserRelay(phase:string, ms:number, bytes:number, bufferedBytes:number) {
  if(browserDiagnostics && browserDiagnostics.length<100_000)browserDiagnostics.push({phase,at:Date.now(),ms,bytes,bufferedBytes});
}
