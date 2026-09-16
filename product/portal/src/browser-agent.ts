import { timingSafeEqual } from 'node:crypto';
import { browserProfileId, type HostBrowserProfile, type ThreadSummary } from '@weave/product-protocol';
import type { BrowserServiceClient } from './browser-service/client.ts';
import { MAX_CDP_BYTES, type CdpMessage } from './browser-service/cdp-pipe.ts';

type Debugger = { debuggerId: string; generation: string };
type Channel = { controlPending?: boolean; epoch: number; threadId: string; token: string; profileId?: string; raw?: Debugger; sockets: Set<Bun.ServerWebSocket<Peer>> };
type Peer = { channel: Channel; debugger?: Debugger; closed: boolean; pending: number };
export type BrowserAgentHost = {
  thread(threadId: string): ThreadSummary;
  backend: Pick<BrowserServiceClient, 'managedPage'>;
  profiles(): Promise<HostBrowserProfile[]>;
  create(threadId: string, profileId: string, url: string): Promise<{ targetId: string }>;
  close(threadId: string, profileId: string, targetId: string): Promise<void>;
};

/** Private, authenticated CDP endpoint for maintained tool servers. Never a browser launcher. */
export class BrowserAgentGateway {
  #channels = new Map<string, Channel>();
  #server: Bun.Server<Peer>;
  #heartbeat: ReturnType<typeof setInterval>;
  #renewing = false;
  constructor(private host: BrowserAgentHost, private launcher: { node: string; script: string }) {
    this.#server = Bun.serve<Peer>({ hostname: '127.0.0.1', port: 0, maxRequestBodySize: MAX_CDP_BYTES,
      fetch: async (request, server) => {
        try {
          // Browser origins have no access, even if they can reach loopback.
          if (request.headers.has('origin')) return new Response('Origin forbidden', { status: 403 });
          const supplied = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
          const channel = [...this.#channels.values()].find(item => supplied.length === item.token.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(item.token)));
          if (!channel) return new Response('Unauthorized', { status: 401 });
          this.#thread(channel);
          const path = new URL(request.url).pathname;
          if (path === '/cdp' && request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
            if (channel.sockets.size >= 4) throw new Error('Browser debugger connection capacity exceeded');
            await this.#chooseProfile(channel);
            this.#authorize(channel);
            if (server.upgrade(request, { data: { channel, closed: false, pending: 0 } })) return;
            return new Response('WebSocket required', { status: 426 });
          }
          if (path !== '/control' || request.method !== 'POST') return new Response('Not found', { status: 404 });
          const input = await request.json() as Record<string, any>;
          if (input.action === 'profiles') {
            const profiles = await this.host.profiles(); this.#thread(channel);
            return Response.json({ profiles, selectedProfileId: channel.profileId });
          }
          if (channel.controlPending) throw new Error('A Browser control command is already running; retry');
          channel.controlPending = true;
          try {
          if (input.action === 'select') {
            const profileId = browserProfileId(input.profileId);
            if (!(await this.host.profiles()).some(profile => profile.profileId === profileId)) throw new Error('Browser Profile unavailable');
            await this.#disconnect(channel); this.#thread(channel);
            channel.profileId = profileId;
            return Response.json({ profileId });
          }
          if (input.action === 'cdp') {
            await this.#chooseProfile(channel);
            const profileId = this.#authorize(channel), epoch = channel.epoch;
            if (!channel.raw) {
              const opened = await this.host.backend.managedPage<Debugger>('debugger.open', { profileId });
              try { this.#authorize(channel, profileId); this.#epoch(channel, epoch); channel.raw = opened; }
              catch (error) { await this.host.backend.managedPage('debugger.close', opened).catch(() => {}); throw error; }
            }
            this.#authorize(channel, profileId);
            const result = input.method ? await this.#dispatch(channel, channel.raw, this.#message({ id: 1, method: input.method, params: input.params ?? {}, sessionId: input.sessionId }), false) : undefined;
            const events = await this.host.backend.managedPage('debugger.events', channel.raw);
            this.#authorize(channel, profileId); this.#epoch(channel, epoch);
            return Response.json({ ...(result ? { response: result } : {}), ...events });
          }
          throw new Error('Unknown Browser control operation');
          } finally { channel.controlPending = false; }
        } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Browser operation failed' }, { status: 400 }); }
      },
      websocket: {
        maxPayloadLength: MAX_CDP_BYTES, backpressureLimit: MAX_CDP_BYTES, closeOnBackpressureLimit: true,
        open: socket => { socket.data.channel.sockets.add(socket); void this.#pump(socket); },
        message: (socket, data) => { void this.#messageReceived(socket, String(data)); },
        close: socket => {
          socket.data.closed = true; socket.data.channel.sockets.delete(socket);
          if (socket.data.debugger) void this.host.backend.managedPage('debugger.close', socket.data.debugger).catch(() => {});
        },
      },
    });
    this.#heartbeat = setInterval(() => {
      if (this.#renewing) return;
      this.#renewing = true;
      void Promise.all([...this.#channels.values()].map(async channel => {
        try {
          this.#thread(channel);
          if (channel.raw) { this.#authorize(channel); await this.host.backend.managedPage('debugger.renew', channel.raw); }
        } catch { await this.#disconnect(channel); }
      })).finally(() => { this.#renewing = false; });
    }, 1000);
    this.#heartbeat.unref();
  }
  #thread(channel: Channel) {
    if (this.#channels.get(channel.threadId) !== channel) throw new Error('Browser tool session expired');
    const thread = this.host.thread(channel.threadId);
    if (thread.status !== 'active') throw new Error('Browser tools require an active Thread');
    return thread;
  }
  async #chooseProfile(channel: Channel) {
    this.#thread(channel);
    if (channel.profileId) return;
    const profiles = await this.host.profiles(); this.#thread(channel);
    if (profiles.length === 1) channel.profileId ??= profiles[0]!.profileId;
  }
  #authorize(channel: Channel, expectedProfile?: string) {
    this.#thread(channel);
    if (!channel.profileId) throw new Error('Select a Host Profile with weave_browser_connect');
    if (expectedProfile && channel.profileId !== expectedProfile) throw new Error('Browser Profile selection changed; retry');
    return channel.profileId;
  }
  #message(input: any): CdpMessage {
    if (!input || !Number.isSafeInteger(input.id) || input.id < 0 || typeof input.method !== 'string' || !/^[A-Za-z]+\.[A-Za-z0-9]+$/.test(input.method) || input.params !== undefined && (!input.params || typeof input.params !== 'object' || Array.isArray(input.params)) || input.sessionId !== undefined && typeof input.sessionId !== 'string') throw new Error('Invalid CDP request');
    return input;
  }
  #epoch(channel: Channel, epoch: number) { if (channel.epoch !== epoch) throw new Error('Browser access changed during the command'); }
  async #dispatch(channel: Channel, debuggerSession: Debugger, message: CdpMessage, compatibility = true) {
    const profileId = this.#authorize(channel), epoch = channel.epoch;
    const params = message.params ?? {};
    let result: unknown;
    if (message.method === 'Target.createTarget') {
      if (Object.keys(params).some(key => !['url', 'background'].includes(key))) throw new Error('Create a Browser Pane in its existing Host Profile; custom browser contexts/windows are unsupported');
      result = await this.host.create(channel.threadId, profileId, String(params.url ?? 'about:blank'));
    } else if (message.method === 'Target.closeTarget') {
      await this.host.close(channel.threadId, profileId, String(params.targetId)); result = { success: true };
    } else {
      if (['Browser.close', 'Target.createBrowserContext', 'Target.disposeBrowserContext'].includes(message.method!)) throw new Error('Host-owned Profile lifecycle must be managed through Portal');
      // CEF momentarily classifies new pages as "other". Do not let Puppeteer
      // create an OtherTarget before Chromium exposes the native Page target.
      if (compatibility && message.method === 'Target.setAutoAttach') message = { ...message, params: { ...params, filter: [{ type: 'other', exclude: true }, ...(params.filter ?? [{}])] } };
      const reply = await this.host.backend.managedPage<CdpMessage>('debugger.send', { ...debuggerSession, message, streamed: compatibility });
      this.#authorize(channel, profileId); this.#epoch(channel, epoch); return compatibility ? undefined : reply;
    }
    this.#authorize(channel, profileId); this.#epoch(channel, epoch);
    return { id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}), result };
  }
  #send(socket: Bun.ServerWebSocket<Peer>, message: unknown) {
    if (socket.data.closed) return;
    this.#authorize(socket.data.channel);
    if (socket.getBufferedAmount() > MAX_CDP_BYTES) { socket.close(1013, 'Debugger consumer fell behind'); return; }
    socket.send(JSON.stringify(message));
  }
  async #pump(socket: Bun.ServerWebSocket<Peer>) {
    const peer = socket.data;
    try {
      const profileId = this.#authorize(peer.channel), epoch = peer.channel.epoch;
      peer.debugger = await this.host.backend.managedPage<Debugger>('debugger.open', { profileId });
      this.#authorize(peer.channel, profileId); this.#epoch(peer.channel, epoch);
      while (!peer.closed) {
        const { events } = await this.host.backend.managedPage<{ events: CdpMessage[] }>('debugger.events', peer.debugger);
        this.#authorize(peer.channel, profileId); this.#epoch(peer.channel, epoch);
        for (const event of events) this.#send(socket, event);
        await Bun.sleep(20);
      }
    } catch (error) { console.error('Browser agent debugger disconnected:', error instanceof Error ? error.message : String(error)); socket.close(1008, 'Browser session or debugger unavailable'); }
    finally { if (peer.debugger) await this.host.backend.managedPage('debugger.close', peer.debugger).catch(() => {}); }
  }
  async #messageReceived(socket: Bun.ServerWebSocket<Peer>, data: string) {
    const peer = socket.data; let message: CdpMessage | undefined;
    if (++peer.pending > 64) { socket.close(1013, 'Debugger command capacity exceeded'); peer.pending--; return; }
    try {
      message = this.#message(JSON.parse(data));
      while (!peer.debugger && !peer.closed) await Bun.sleep(5);
      if (!peer.debugger || peer.closed) return;
      const reply = await this.#dispatch(peer.channel, peer.debugger, message);
      if (reply) this.#send(socket, reply);
    } catch (error) {
      try { this.#send(socket, { id: message?.id, ...(message?.sessionId ? { sessionId: message.sessionId } : {}), error: { code: -32000, message: error instanceof Error ? error.message : 'Browser command failed' } }); }
      catch { socket.close(1008, 'Browser session unavailable'); }
    } finally { peer.pending--; }
  }
  servers(threadId: string) {
    const previous = this.#channels.get(threadId); if (previous) void this.#disconnect(previous);
    const channel: Channel = { epoch: 0, threadId, token: crypto.randomUUID() + crypto.randomUUID(), sockets: new Set() };
    this.#channels.set(threadId, channel);
    return [{ name: 'weave-browser', command: this.launcher.node, args: [this.launcher.script], env: [
      { name: 'WEAVE_BROWSER_ENDPOINT', value: `http://127.0.0.1:${this.#server.port}` },
      { name: 'WEAVE_BROWSER_TOKEN', value: channel.token },
    ] }];
  }
  async #disconnect(channel: Channel) {
    channel.epoch++;
    for (const socket of channel.sockets) socket.close(1008, 'Browser access changed; reconnect');
    const raw = channel.raw; channel.raw = undefined;
    if (raw) await this.host.backend.managedPage('debugger.close', raw).catch(() => {});
  }
  async close() { clearInterval(this.#heartbeat); await Promise.all([...this.#channels.values()].map(channel => this.#disconnect(channel))); this.#channels.clear(); void this.#server.stop(true); this.#server.unref(); }
}
