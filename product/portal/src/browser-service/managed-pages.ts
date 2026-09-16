import { CdpPipeSession, type CdpMessage } from './cdp-pipe.ts';
import { readFile, lstat, rename, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { browserProfileId } from '@weave/product-protocol';
import { privateDirectory } from './chromium.ts';
import { BrowserProfiles } from './profiles.ts';
import { ManagedBrowserProcess, type ManagedPage, type ManagedBrowserEvent } from './managed-process.ts';

export type ManagedPageRecord = { pageId: string; profileId: string; title: string; url: string; openerPageId?: string; temporary?: boolean; profileLocked?: boolean };
export type ManagedPageSummary = ManagedPageRecord & { available: boolean; generation?: string; rfbSocket?: string; width?: number; height?: number; deviceScaleFactor?: number; canGoBack?: boolean; canGoForward?: boolean };
type Runtime = { generation: string; process: ManagedRuntime; pages: Map<string, ManagedPage>; unsubscribe: () => void };
export type ManagedRuntime = Pick<ManagedBrowserProcess, 'available' | 'request' | 'subscribe' | 'close'> & Partial<Pick<ManagedBrowserProcess, 'cdp'>>;
export type ManagedRuntimeFactory = (options: { binary: string; directory: string }) => Promise<ManagedRuntime>;
export const managedPageUrl = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('Invalid browser URL');
  const url = new URL(value);
  if (!['http:', 'https:', 'about:'].includes(url.protocol) || url.protocol === 'about:' && value !== 'about:blank' || url.username || url.password) throw new Error('Unsupported browser URL');
  return url.href;
};

/** Durable page identities and metadata, with explicit restoration after runtime loss. */
export class ManagedBrowserPages {
  #openingDebuggers = 0;
  #debuggers = new Map<string, { profileId: string; runtime: Runtime; session: CdpPipeSession; expires: number }>();
  #runtimes = new Map<string, Promise<Runtime>>();
  #releasing = new Map<string, Promise<void>>();
  #records?: Map<string, ManagedPageRecord>;
  #writes: Promise<unknown> = Promise.resolve();
  #closing?: Promise<void>;
  #events: ManagedBrowserEvent[] = [];
  #operations = new Map<string, Promise<unknown>>();
  constructor(readonly directory: string, readonly binary: string, readonly profiles: BrowserProfiles, private launch: ManagedRuntimeFactory = ManagedBrowserProcess.launch) {}
  #ordered<T>(operation: () => Promise<T>) { const next = this.#writes.catch(() => {}).then(operation).catch(error => { this.#records = undefined; throw error; }); this.#writes = next; return next; }
  #pageOperation<T>(pageId: string, operation: () => Promise<T>): Promise<T> {
    if (this.#closing) return Promise.reject(new Error('Browser Service is stopping'));
    const next = (this.#operations.get(pageId) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.#operations.set(pageId, next);
    void next.finally(() => { if (this.#operations.get(pageId) === next) this.#operations.delete(pageId); }).catch(() => {});
    return next;
  }
  async #load() {
    if (this.#records) return this.#records;
    await privateDirectory(this.directory);
    const path = join(this.directory, 'pages.json');
    let records: ManagedPageRecord[] = [];
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > 1024 * 1024) throw new Error('Unsafe browser page catalog');
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.pages) || value.pages.length > 256) throw new Error('Invalid browser page catalog');
      records = value.pages.map((record: ManagedPageRecord) => ({ pageId: browserProfileId(record.pageId), profileId: browserProfileId(record.profileId), url: managedPageUrl(record.url), temporary: record.temporary === true, profileLocked: record.profileLocked ?? (!record.temporary && record.url !== 'about:blank'), title: typeof record.title === 'string' ? record.title.slice(0,1024) : '', ...(record.openerPageId ? { openerPageId: browserProfileId(record.openerPageId) } : {}) }));
      if (new Set(records.map(record => record.pageId)).size !== records.length) throw new Error('Duplicate browser page identity');
    } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
    return this.#records = new Map(records.map(record => [record.pageId, record]));
  }
  async #save() {
    const path = join(this.directory, 'pages.json'), temporary = `${path}.${crypto.randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify({ version: 1, pages: [...this.#records!.values()] })+'\n', { flag:'wx', mode:0o600 }); await rename(temporary,path); }
    finally { await rm(temporary,{force:true}); }
  }
  async #runtime(profileId: string) {
    if (this.#closing) throw new Error('Browser Service is stopping');
    let pending = this.#runtimes.get(profileId);
    if (!pending) {
      if (this.#runtimes.size >= 16) throw new Error('Browser runtime capacity exceeded');
      pending = (async () => {
        const directory = await this.profiles.dataDirectory(profileId);
        const process = await this.launch({ binary:this.binary, directory });
        const runtime: Runtime = { generation:crypto.randomUUID(),process,pages:new Map(),unsubscribe:()=>{} };
        runtime.unsubscribe = process.subscribe(event => {
          if (this.#closing) return;
          // CDP events are live only; page metadata is persisted by the one catalog writer.
          if (event.method === 'page.cdp.event') { this.#enqueue({ ...event, params: { ...event.params, profileId, generation:runtime.generation } }); return; }
          void this.#ordered(async () => {
            const records = await this.#load();
            const page = event.params as ManagedPage;
            if (event.method === 'page.closed') {
              if (records.get(page.pageId)?.profileId !== profileId) return;
              runtime.pages.delete(page.pageId); records.delete(page.pageId);
            }
            else if (event.method === 'page.created' || event.method === 'page.changed') {
              browserProfileId(page.pageId);
              const old = records.get(page.pageId);
              if (old && old.profileId !== profileId) return; // Late events from a replaced storage identity.
              if (!old && event.method !== 'page.created') return;
              if (!old && !page.openerPageId) return;
              if (!old && (records.get(page.openerPageId!)?.profileId !== profileId || records.size >= 256)) { void process.request('page.close',{pageId:page.pageId}).catch(() => {}); return; }
              runtime.pages.set(page.pageId,page);
              let url = old?.url ?? 'about:blank'; try { url=managedPageUrl(page.url); } catch {}
              const temporary = (await this.profiles.require(profileId)).temporary === true;
              records.set(page.pageId,{pageId:page.pageId,profileId,url,temporary,profileLocked:old?.profileLocked === true || (!temporary && url !== 'about:blank'),title:page.title.slice(0,1024),...(page.openerPageId?{openerPageId:page.openerPageId}:{})});
            } else return;
            await this.#save(); this.#enqueue({ method:event.method,params:{ ...event.params,profileId,generation:runtime.generation } });
            if (event.method === 'page.closed') void this.#releaseTemporary(profileId).catch(error => this.#enqueue({method:'page.error',params:{profileId,message:String(error)}}));
          }).catch(error => this.#enqueue({method:'page.error',params:{profileId,message:String(error)}}));
        });
        return runtime;
      })();
      this.#runtimes.set(profileId,pending);
      void pending.catch(() => {if(this.#runtimes.get(profileId)===pending)this.#runtimes.delete(profileId);});
    }
    const runtime=await pending;
    if(!runtime.process.available)throw new Error('Browser runtime unavailable; restore the page explicitly');
    return runtime;
  }
  #enqueue(event:ManagedBrowserEvent) { if(this.#events.length>=256)this.#events=[{method:'runtime.events.reset',params:{reason:'Event consumer fell behind; refresh page state'}}];this.#events.push(event); }
  // Private service consumer: poll and refresh the catalog after reconnect.
  events() { return this.#events.splice(0); }
  async list(profileId?:string):Promise<ManagedPageSummary[]> {
    const records=await this.#ordered(async()=>[...(await this.#load()).values()]);
    const result:ManagedPageSummary[]=[];
    for(const record of records) {
      if(profileId&&record.profileId!==profileId)continue;
      const runtime=await this.#runtimes.get(record.profileId)?.catch(()=>undefined);
      const page=runtime?.process.available?runtime.pages.get(record.pageId):undefined;
      result.push({...record,available:Boolean(page),...(page?{rfbSocket:page.rfbSocket,width:page.width,height:page.height,deviceScaleFactor:page.deviceScaleFactor,canGoBack:page.canGoBack,canGoForward:page.canGoForward,generation:runtime!.generation}:{})});
    }
    return result;
  }
  create(profileId:string|undefined,pageId:string,url:string) {
    return this.#pageOperation(pageId, () => this.#create(profileId,pageId,url));
  }
  async #create(profileId:string|undefined,pageId:string,url:string) {
    browserProfileId(pageId);url=managedPageUrl(url);
    const old = await this.#ordered(async () => (await this.#load()).get(pageId));
    const profile = profileId ? await this.profiles.require(profileId) : old ? await this.profiles.require(old.profileId) : await this.profiles.temporary(crypto.randomUUID());
    profileId = profile.profileId;
    const existed=await this.#ordered(async()=>{
      const records=await this.#load(),old=records.get(pageId);
      if(old) {if(old.profileId!==profileId)throw new Error('Page belongs to another Profile');return true;}
      if(records.size>=256)throw new Error('Browser page capacity exceeded');
      records.set(pageId,{pageId,profileId:profile.profileId,url,title:'',temporary:profile.temporary === true,profileLocked:!profile.temporary && url !== 'about:blank'});await this.#save();return false;
    });
    if(existed)return (await this.list(profileId)).find(page=>page.pageId===pageId)!;
    return this.#createRuntimePage(profileId,pageId,url);
  }
  async #createRuntimePage(profileId:string,pageId:string,url:string) {
    const runtime=await this.#runtime(profileId);
    const page=await runtime.process.request<ManagedPage>('page.create',{pageId,url});
    runtime.pages.set(pageId,page);
    const record = await this.#ordered(async () => (await this.#load()).get(pageId));
    return {...record,...page,url,title:page.title.slice(0,1024),profileId,available:true,generation:runtime.generation};
  }
  restore(pageId:string) {
    return this.#pageOperation(pageId, () => this.#restore(pageId));
  }
  async #restore(pageId:string) {
    const record=await this.#ordered(async()=>(await this.#load()).get(browserProfileId(pageId)));
    if(!record)throw new Error('Browser page unavailable');
    const pending=this.#runtimes.get(record.profileId),runtime=await pending?.catch(()=>undefined);
    if(runtime&&!runtime.process.available){runtime.unsubscribe();await runtime.process.close();this.#runtimes.delete(record.profileId);}
    return this.#createRuntimePage(record.profileId,pageId,record.url);
  }
  command(pageId:string,generation:string,method:string,args:Record<string,unknown>={}) {
    return this.#pageOperation(pageId, () => this.#command(pageId,generation,method,args));
  }
  async #command(pageId:string,generation:string,method:string,args:Record<string,unknown>={}) {
    const record=await this.#ordered(async()=>(await this.#load()).get(browserProfileId(pageId)));
    if(!record)throw new Error('Browser page unavailable');
    const runtime=await this.#runtimes.get(record.profileId);
    if(!runtime||runtime.generation!==generation||!runtime.process.available||!runtime.pages.has(pageId))throw new Error('Stale or unavailable browser page');
    if(method==='page.navigate') {
      args={url:managedPageUrl(args.url)};
      if (!record.temporary && args.url !== 'about:blank') await this.#ordered(async () => { const current=(await this.#load()).get(pageId)!; current.profileLocked=true; await this.#save(); });
    }
    if(!['page.navigate','page.back','page.forward','page.reload','page.resize','page.interaction','page.context','page.cdp','page.close'].includes(method))throw new Error('Unknown managed page operation');
    return runtime.process.request(method,{...args,pageId});
  }
  closePage(pageId:string,generation?:string) {
    return this.#pageOperation(pageId, () => this.#closePage(pageId,generation));
  }
  async #closePage(pageId:string,generation?:string) {
    const record=await this.#ordered(async()=>(await this.#load()).get(browserProfileId(pageId)));
    if(!record)return;
    const runtime=await this.#runtimes.get(record.profileId)?.catch(()=>undefined);
    if(runtime?.process.available&&runtime.pages.has(pageId)) {
      if(generation!==runtime.generation)throw new Error('Stale browser page generation');
      await runtime.process.request('page.close',{pageId});
    }
    await this.#ordered(async()=>{(await this.#load()).delete(pageId);await this.#save();});
    await this.#releaseTemporary(record.profileId);
  }
  #releaseTemporary(profileId: string): Promise<void> {
    const active=this.#releasing.get(profileId); if (active) return active;
    const release=this.#doReleaseTemporary(profileId).finally(() => { this.#releasing.delete(profileId); });
    this.#releasing.set(profileId,release); return release;
  }
  async #doReleaseTemporary(profileId: string) {
    const profile = (await this.profiles.list()).find(item => item.profileId === profileId);
    if (!profile?.temporary || (await this.list(profileId)).length) return;
    const pending = this.#runtimes.get(profileId);
    // Remove before awaiting close so a second cleanup cannot close a replacement runtime.
    if (pending) { this.#runtimes.delete(profileId); const runtime = await pending.catch(() => undefined); runtime?.unsubscribe(); await runtime?.process.close(); }
    for (const [id, entry] of this.#debuggers) if (entry.profileId === profileId) await this.closeDebugger(id);
    if (profile.temporary) await this.profiles.releaseTemporary(profileId);
  }
  selectProfile(pageId: string, profileId: string, selectedProfileId?: string) {
    return this.#pageOperation(pageId, async () => {
      const old = await this.#ordered(async () => (await this.#load()).get(pageId));
      if (!old || old.profileId !== profileId) throw new Error('Browser identity changed; reload the Pane');
      if (old.profileLocked) throw new Error('Profile is locked after loading a page with it');
      if (selectedProfileId === profileId || !selectedProfileId && old.temporary) return (await this.list(profileId)).find(page => page.pageId === pageId)!;
      if (selectedProfileId && (await this.profiles.require(selectedProfileId)).temporary) throw new Error('Choose a named Profile');
      const selected = selectedProfileId ? await this.profiles.require(selectedProfileId) : await this.profiles.temporary(crypto.randomUUID());
      // Start the replacement before closing the old page. A missing runtime must not destroy live work.
      try { await this.#runtime(selected.profileId); }
      catch (error) { await this.#releaseTemporary(selected.profileId); throw error; }
      const current = (await this.list(profileId)).find(page => page.pageId === pageId)!;
      await this.#closePage(pageId, current.generation);
      try { return await this.#create(selected.profileId,pageId,old.url); }
      catch (error) {
        const replacement=(await this.list(selected.profileId)).find(page => page.pageId === pageId);
        if (replacement) return replacement; // Composition can adopt the new identity and offer Restore.
        if (old.temporary) await this.profiles.temporary(old.profileId);
        await this.#ordered(async () => { (await this.#load()).set(pageId,old); await this.#save(); });
        await this.#releaseTemporary(selected.profileId);
        throw error;
      }
    });
  }
  async openDebugger(profileId: string) {
    await this.expireDebuggers();
    if (this.#closing) throw new Error('Browser Service closing');
    if (this.#debuggers.size + this.#openingDebuggers >= 32) throw new Error('Browser debugger capacity exceeded');
    this.#openingDebuggers++;
    try {
    const runtime = await this.#runtime(profileId);
    if (!runtime.process.cdp) throw new Error('Browser runtime lacks private CDP support');
    const session = await CdpPipeSession.open(runtime.process.cdp);
    if (this.#closing) { await session.close(); throw new Error('Browser Service closing'); }
    const debuggerId = crypto.randomUUID();
    this.#debuggers.set(debuggerId, { profileId, runtime, session, expires: Date.now() + 30_000 });
    return { debuggerId, generation: runtime.generation };
    } finally { this.#openingDebuggers--; }
  }
  async debuggerRequest(debuggerId: string, generation: string, message?: CdpMessage, renew = false, streamed = false) {
    const entry = this.#debuggers.get(debuggerId);
    if (!entry || entry.expires < Date.now() || !entry.runtime.process.available || entry.runtime.generation !== generation) {
      await this.closeDebugger(debuggerId); throw new Error('Browser debugger unavailable; reconnect required');
    }
    entry.expires = Date.now() + 30_000;
    if (renew) return {};
    if (message && streamed) { entry.session.dispatch(message); return {}; }
    return message ? entry.session.send(message) : { events: entry.session.events() };
  }
  async closeDebugger(debuggerId: string) {
    const entry = this.#debuggers.get(debuggerId); this.#debuggers.delete(debuggerId);
    await entry?.session.close();
  }
  async expireDebuggers() {
    await Promise.all([...this.#debuggers].filter(([, entry]) => entry.expires < Date.now() || !entry.runtime.process.available).map(([id]) => this.closeDebugger(id)));
  }
  close() {
    return this.#closing??=(async()=>{
      await Promise.all([...this.#debuggers.keys()].map(id => this.closeDebugger(id)));
      // Service shutdown preserves page records for explicit Restore. Stop accepting lifecycle events before closing runtimes.
      await Promise.allSettled(this.#operations.values());
      const records=await this.#ordered(async()=>new Map(await this.#load()));
      await Promise.allSettled([...this.#runtimes.values()].map(async pending=>(await pending).process.close()));
      await this.#ordered(async()=>{this.#records=records;await this.#save();});
      this.#runtimes.clear();
    })();
  }
}
