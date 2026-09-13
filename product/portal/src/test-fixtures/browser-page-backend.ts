import type { BrowserBackend } from '../browsers.ts';
import type { ManagedPageSummary } from '../browser-service/managed-pages.ts';
export function browserPageBackend(path = '/private/fixture.sock') {
  const profileId = crypto.randomUUID(), generation = crypto.randomUUID(), pageId = crypto.randomUUID();
  const page: ManagedPageSummary = { profileId, pageId, generation, title: 'Fixture', url: 'https://example.com/', available: true, width: 800, height: 600, canGoBack: false, canGoForward: false, rfbSocket: path };
  const calls: Array<{ method: string; args: any }> = [];
  let before: ((method: string, args: any) => Promise<void>) | undefined;
  const backend: BrowserBackend = {
    managedPagesEnabled: true,
    async managedPage<T>(method: string, args: any = {}): Promise<T> {
      calls.push({ method, args });
      await before?.(method, args);
      if (method === 'page.list') return { pages: [{ ...page }] } as T;
      if (method === 'page.resize') Object.assign(page, args.arguments);
      if (method === 'page.restore') { page.available = true; page.generation = crypto.randomUUID(); }
      return { ...page } as T;
    },
    browser: async () => { throw new Error('Legacy browser not configured'); },
    events: async () => [], renew: async () => ({ expiresAt: 0 }), detach: async () => {}, dispose() {},
  };
  return { backend, page, calls, intercept: (callback?: typeof before) => { before = callback; } };
}
