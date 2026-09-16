import { join } from 'node:path';
const root = process.argv[2];
if (!root) throw new Error('Pass the benchmark evidence directory');
const read = (name: string) => Bun.file(join(root, name)).json();
const result = await read('result.json');
const run = result.hosts[0].benchmark;
const inside = (at: number) => at >= run.startEpochMs && at <= run.endEpochMs;
const native = (await read('native-performance.json')).filter((row: any) => inside(row.epochMs) && (!run.diagnosticId || row.diagnosticId === run.diagnosticId));
const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? null;
  return { count: values.length, mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null, p50: q(.5), p95: q(.95), p99: q(.99), max: q(1) };
};
const distinct = native.filter((row: any, i: number) => i === 0 || (run.animation ? row.sequence !== native[i - 1].sequence : row.scroll !== native[i - 1].scroll));
const intervals = distinct.slice(1).map((row: any, i: number) => (row.time - distinct[i].time) * 1000);
const phases = (await read('portal-performance.json')).filter((row: any) => inside(row.at));
const inputs = run.input.filter((row: any) => inside(row.capturedAt));
// First forward segment starts at scrollY=0. Later reversals can hit a boundary
// and invalidate cumulative-target matching, so do not invent latency there.
const latency: number[] = [];
for (const event of run.events.filter((e: any) => e.at < run.startEpochMs + 4500)) {
  const response = native.find((frame: any) => frame.epochMs >= event.at && frame.epochMs < run.startEpochMs + 5000 && frame.scroll >= event.target);
  if (response) latency.push(response.epochMs - event.at);
}
const cef = (await Bun.file(join(root, 'cef-performance.jsonl')).text()).trim().split('\n').map(line => JSON.parse(line)).filter(row => inside(row.epochMs));
const resources = (await read('resources.json')).filter((row: any) => inside(row.at));
const seconds = (run.endEpochMs - run.startEpochMs) / 1000;
const settled = await read('page-result.json');
const expectedScrollY = run.events.reduce((y: number, event: { deltaY: number }) => Math.max(0, y + event.deltaY), 0);
const intervalStats = stats(intervals);
const summary = {
  root, route: await Bun.file(join(root,'route.json')).exists() ? await read('route.json') : 'Mac loopback; software event capture to native layer submission, not physical scanout', seconds,
  viewport: { width: run.width, height: run.height, shellDpr: run.devicePixelRatio },
  animation: run.animation, submittedFPS: native.length / seconds, distinctContentFPS: distinct.length / seconds,
  distinctIntervalsMs: intervalStats, inputToLayerMsFirstForwardSegment: stats(latency),
  inputEvents: run.events.length, inputRPCs: inputs.length, failedRPCs: inputs.filter((i: any) => !i.ok).length,
  queueMs: stats(inputs.map((i: any) => i.queueMs)), rpcMs: stats(inputs.map((i: any) => i.rpcMs)), pending: stats(inputs.map((i: any) => i.pending)),
  portal: Object.fromEntries(['queue', 'authorize', 'page', 'cdp'].map(phase => [phase, stats(phases.filter((r: any) => r.phase === phase).map((r: any) => r.ms))])),
  presenters: [...new Set(native.map((row:any)=>row.presenter ?? 'cgimage'))],
  metalVerification: { frames:native.filter((r:any)=>r.verifiedPixels>0).length, differentPixels:native.reduce((sum:number,r:any)=>sum+(r.differentPixels ?? 0),0), errors:[...new Set(native.map((r:any)=>r.presenterError).filter(Boolean))] },
  contentsFormats: [...new Set(native.map((row:any)=>row.contentsFormat ?? 'unrecorded'))],
  native: Object.fromEntries(['copyMs', 'mainQueueMs', 'submitMs', 'renderCPUms', 'gpuMs', 'transferWallMs', 'decodeMs', 'receiveGapMs'].map(key => [key, stats(native.map((r: any) => r[key]).filter(Number.isFinite))])),
  mbps: native.length > 1 ? (native.at(-1).receivedBytes - native[0].receivedBytes) * 8 / seconds / 1e6 : null,
  decoderCorePercent: native.length > 1 ? (native.at(-1).decodeCPUSeconds - native[0].decodeCPUSeconds) * 100 / seconds : null,
  cef: { paintFPS: stats(cef.map(r => r.paints / r.seconds)), pumpMsPerSecond: stats(cef.map(r => r.pumpTotalMs / r.seconds)), worstPumpMs: stats(cef.map(r => r.pumpMaxMs)) },
  resourceEstimate: { cpuPercent: stats(resources.map((r: any) => r.cpuPercent)), rssMiB: stats(resources.map((r: any) => r.rssKiB / 1024)) },
  settled, expectedScrollY, displacementPreserved: settled.scrollY === expectedScrollY,
  cadenceGate: distinct.length / seconds >= 57 && intervalStats.p95 !== null && intervalStats.p95 <= 25 && intervalStats.p99 !== null && intervalStats.p99 <= 50,
};
await Bun.write(join(root, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
