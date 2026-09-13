import { readFile, lstat, rename, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { browserProfileId } from '@weave/product-protocol';
import { privateDirectory } from './chromium.ts';
import { BrowserProfiles } from './profiles.ts';
import { ManagedBrowserProcess, type ManagedPage, type ManagedBrowserEvent } from './managed-process.ts';

export type ManagedPageRecord = { pageId: string; profileId: string; title: string; url: string; openerPageId?: string };
export type ManagedPageSummary = ManagedPageRecord & { available: boolean; generation?: string; rfbSocket?: string; width?: number; height?: number; canGoBack?: boolean; canGoForward?: boolean };
type Runtime = { generation: string; process: ManagedRuntime; pages: Map<string, ManagedPage>; unsubscribe: () => void };
export type ManagedRuntime = Pick<ManagedBrowserProcess, 'available' | 'request' | 'subscribe' | 'close'>;
export type ManagedRuntimeFactory = (options: { binary: string; directory: string }) => Promise<ManagedRuntime>;
export const managedPageUrl = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('Invalid browser URL');
  const url = new URL(value);
  if (!['http:', 'https:', 'about:'].includes(url.protocol) || url.protocol === 'about:' && value !== 'about:blank' || url.username || url.password) throw new Error('Unsupported browser URL');
  return url.href;
};

/** Durable page identities and metadata, with explicit restoration after runtime loss. */
export class ManagedBrowserPages {
  #runtimes = new Map<string, Promise<Runtime>>();
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
      records = value.pages.map((record: ManagedPageRecord) => ({ pageId: browserProfileId(record.pageId), profileId: browserProfileId(record.profileId), url: managedPageUrl(record.url), title: typeof record.title === 'string' ? record.title.slice(0,1024) : '', ...(record.openerPageId ? { openerPageId: browserProfileId(record.openerPageId) } : {}) }));
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
            if (event.method === 'page.closed') {runtime.pages.delete(page.pageId);records.delete(page.pageId);}
            else if (event.method === 'page.created' || event.method === 'page.changed') {
              browserProfileId(page.pageId);
              const old = records.get(page.pageId);
              if (old && old.profileId !== profileId) throw new Error('Runtime reported a page in another Profile');
              if (!old && event.method !== 'page.created') return;
              if (!old && !page.openerPageId) return;
              if (!old && (records.get(page.openerPageId!)?.profileId !== profileId || records.size >= 256)) { void process.request('page.close',{pageId:page.pageId}).catch(() => {}); return; }
              runtime.pages.set(page.pageId,page);
              let url = old?.url ?? 'about:blank'; try { url=managedPageUrl(page.url); } catch {}
              records.set(page.pageId,{pageId:page.pageId,profileId,url,title:page.title.slice(0,1024),...(page.openerPageId?{openerPageId:page.openerPageId}:{})});
            } else return;
            await this.#save(); this.#enqueue({ method:event.method,params:{ ...event.params,profileId,generation:runtime.generation } });
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
      result.push({...record,available:Boolean(page),...(page?{rfbSocket:page.rfbSocket,width:page.width,height:page.height,canGoBack:page.canGoBack,canGoForward:page.canGoForward,generation:runtime!.generation}:{})});
    }
    return result;
  }
  create(profileId:string,pageId:string,url:string) {
    return this.#pageOperation(pageId, () => this.#create(profileId,pageId,url));
  }
  async #create(profileId:string,pageId:string,url:string) {
    browserProfileId(pageId);url=managedPageUrl(url);await this.profiles.require(profileId);
    const existed=await this.#ordered(async()=>{
      const records=await this.#load(),old=records.get(pageId);
      if(old) {if(old.profileId!==profileId)throw new Error('Page belongs to another Profile');return true;}
      if(records.size>=256)throw new Error('Browser page capacity exceeded');
      records.set(pageId,{pageId,profileId,url,title:''});await this.#save();return false;
    });
    if(existed)return (await this.list(profileId)).find(page=>page.pageId===pageId)!;
    return this.#createRuntimePage(profileId,pageId,url);
  }
  async #createRuntimePage(profileId:string,pageId:string,url:string) {
    const runtime=await this.#runtime(profileId);
    const page=await runtime.process.request<ManagedPage>('page.create',{pageId,url});
    runtime.pages.set(pageId,page);return {...page,url,title:page.title.slice(0,1024),profileId,available:true,generation:runtime.generation};
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
  async command(pageId:string,generation:string,method:string,args:Record<string,unknown>={}) {
    const record=await this.#ordered(async()=>(await this.#load()).get(browserProfileId(pageId)));
    if(!record)throw new Error('Browser page unavailable');
    const runtime=await this.#runtimes.get(record.profileId);
    if(!runtime||runtime.generation!==generation||!runtime.process.available||!runtime.pages.has(pageId))throw new Error('Stale or unavailable browser page');
    if(method==='page.navigate')args={url:managedPageUrl(args.url)};
    if(!['page.navigate','page.back','page.forward','page.reload','page.resize','page.cdp','page.close'].includes(method))throw new Error('Unknown managed page operation');
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
  }
  close() {
    return this.#closing??=(async()=>{
      // Service shutdown preserves page records for explicit Restore. Stop accepting lifecycle events before closing runtimes.
      await Promise.allSettled(this.#operations.values());
      const records=await this.#ordered(async()=>new Map(await this.#load()));
      await Promise.allSettled([...this.#runtimes.values()].map(async pending=>(await pending).process.close()));
      await this.#ordered(async()=>{this.#records=records;await this.#save();});
      this.#runtimes.clear();
    })();
  }
}
