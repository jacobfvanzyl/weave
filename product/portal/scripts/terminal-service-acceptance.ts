import { connect } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { strict as assert } from 'node:assert';
import { TerminalServiceClient } from '../src/terminal-service/client.ts';
import { serviceDirectory, encodeServiceFrame, ServiceFrameReader, TERMINAL_CODEC, TERMINAL_SERVICE_VERSION } from '../src/terminal-service/contract.ts';
const state = await mkdtemp(join(tmpdir(), 'weave-terminal-acceptance-'));
const executable = resolve(import.meta.dir, '../dist/weave-terminal-service');
let client = new TerminalServiceClient(state, executable);
let output = '';
const subscribe = () => client.subscribe((header, bytes) => { if (header.event === 'output') output = (output + bytes.toString()).slice(-2 * 1024 * 1024); });
subscribe();
const waitFor = async (predicate: () => boolean, label: string) => {
  const until = Date.now() + 15000;
  while (!predicate() && Date.now() < until) await Bun.sleep(10);
  assert(predicate(), `${label}; last output: ${JSON.stringify(output.slice(-300))}`);
};
try {
  assert.deepEqual(await client.list(), []);
  const created = await client.request({ method: 'create', terminalId: 'acceptance', executionContextId: 'context', cwd: state, cols: 80, rows: 24, env: { PATH: process.env.PATH!, SHELL: '/bin/bash', HOME: state, PS1: 'WEAVE> ' } });
  const pid = (created.terminal as { pid: number }).pid;
  const generation = client.generation;
  await client.request({ method: 'input', terminalId: 'acceptance' }, Buffer.from("printf 'IDENTITY:%s\\n' $$\n"));
  await waitFor(() => output.includes(`IDENTITY:${pid}`), 'Real shell PID');
  // Real foreground ownership is stronger evidence than isatty/stty alone.
  // A pre-created Bun.Terminal used to skip setsid/TIOCSCTTY and passed those checks.
  await client.request({ method: 'input', terminalId: 'acceptance' }, Buffer.from("python3 -c 'import os; fd=os.open(\"/dev/tty\",os.O_RDWR); print(\"CONTROLLING_TTY_OK\" if os.tcgetpgrp(fd)==os.getpgrp() else \"NO_FOREGROUND\"); os.close(fd)'\n"));
  await waitFor(() => output.includes('\r\nCONTROLLING_TTY_OK'), 'Foreground job owns the controlling terminal');
  await client.request({ method: 'input', terminalId: 'acceptance' }, Buffer.from("sleep 30\n"));
  await Bun.sleep(100);
  await client.request({ method: 'input', terminalId: 'acceptance' }, Buffer.from([3]));
  await client.request({ method: 'input', terminalId: 'acceptance' }, Buffer.from("printf 'INTERRUPTED:%s\\n' $$\n"));
  await waitFor(() => output.includes(`INTERRUPTED:${pid}`), 'Ctrl-C interrupts the foreground job and returns to the same shell');
  const snapshot = await client.request({ method: 'snapshot', terminalId: 'acceptance' });
  assert.equal(snapshot.payload.subarray(0,8).toString(), 'GHOSTSNP');
  client.dispose();
  client = new TerminalServiceClient(state, executable); subscribe();
  const records = await client.list();
  assert.equal(client.generation, generation); assert.equal(records[0].pid, pid);
  await client.request({ method: 'input', terminalId: 'acceptance' }, Buffer.from("printf 'SURVIVED:%s\\n' $$\n"));
  await waitFor(() => output.includes(`SURVIVED:${pid}`), 'Same shell survives disconnected daemon client');
  await client.request({ method: 'resize', terminalId: 'acceptance', cols: 97, rows: 31 });
  await client.request({ method: 'input', terminalId: 'acceptance' }, Buffer.from('stty size\n'));
  await waitFor(() => output.includes('31 97'), 'Real PTY resize');
  // Raw-mode query probe reads from the actual PTY; two viewers cannot add replies.
  const viewer = new TerminalServiceClient(state, executable); await viewer.list();
  const python = "import os,tty,termios,select; fd=0; old=termios.tcgetattr(fd); tty.setraw(fd); os.write(1,b'\\x1b[c'); data=b'';\nwhile select.select([fd],[],[],0.3)[0]: data+=os.read(fd,4096)\ntermios.tcsetattr(fd,termios.TCSANOW,old); print('REPLY:'+data.hex())";
  const command = "python3 -c '" + python.replaceAll("'", "'\\''") + "'\n";
  await client.request({ method: 'input', terminalId: 'acceptance' }, Buffer.from(command));
  await waitFor(() => output.includes('REPLY:1b5b3f36323b323263'), 'One authoritative device response');
  assert(!output.includes('REPLY:1b5b3f36323b3232631b'));
  viewer.dispose();
  // A stalled Host IPC consumer must be disconnected without stopping the PTY
  // or the healthy Host connection. This is the real protected socket boundary.
  const slow = connect(join(serviceDirectory(state), 'service.sock'));
  const slowReader = new ServiceFrameReader();
  let stalledClosed = false; slow.on('error', () => {}); slow.on('close', () => { stalledClosed = true; });
  await new Promise<void>((resolve, reject) => {
    slow.once('error', reject);
    slow.once('connect', () => slow.write(encodeServiceFrame({ id: 1, method: 'hello', version: TERMINAL_SERVICE_VERSION, codec: TERMINAL_CODEC })));
    slow.on('data', data => slowReader.receive(Buffer.from(data), header => { if (header.id === 1) resolve(); }));
  });
  slow.pause();
  await client.request({ method: 'input', terminalId: 'acceptance' }, Buffer.from("python3 -c 'import os,time; [(os.write(1,(b\"x\"*80+b\"\\r\\n\")*100),time.sleep(.002)) for _ in range(1000)]; print(\"FLOOD_FINISHED\")'\n"));
  await waitFor(() => output.includes('\r\nFLOOD_FINISHED'), 'Healthy consumer receives flood completion');
  slow.resume();
  await waitFor(() => stalledClosed, 'Slow consumer is detached at the queue bound');
  assert.equal((await client.list())[0].pid, pid);
  const large = await client.request({ method: 'snapshot', terminalId: 'acceptance' });
  assert((large.offsets as number[]).length > 2, 'Large history has incremental pages');
  assert((large.offsets as number[])[0] < large.payload.length, 'READY precedes history');
  await client.request({ method: 'input', terminalId: 'acceptance' }, Buffer.from("printf 'AFTER_FLOOD:%s\\n' $$\n"));
  await waitFor(() => output.includes(`AFTER_FLOOD:${pid}`), 'Terminal remains usable after flow control');
  await client.request({ method: 'close', terminalId: 'acceptance' });
  assert.deepEqual(await client.list(), []);
  await client.request({ method: 'shutdown' });
  console.log(JSON.stringify({ passed: true, realPty: true, shellPidSurvived: pid, generationSurvived: true, binarySnapshot: true, resize: true, singleReplyWithTwoClients: true, outputFloodBytes: 8200000, stalledConsumerDetached: true, incrementalLargeHistory: true }));
} finally {
  try { await client.request({ method: 'close', terminalId: 'acceptance' }); await client.request({ method: 'shutdown' }); } catch {}
  client.dispose(); await rm(state, { recursive: true, force: true }); await rm(serviceDirectory(state), { recursive: true, force: true });
}
