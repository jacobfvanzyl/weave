import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe('composer drafts', () => {
  it('outlive the web view, as when iOS discards it in the background', async () => {
    const before = await import('./composer-drafts');
    before.writeComposerDraft('host-1/s-1', { revision: 3, text: 'half a thought' });
    before.writeComposerDraft('host-1/s-2', { revision: 1, text: 'sent' });
    before.writeComposerDraft('host-1/s-2', { revision: 2, text: '' });

    vi.resetModules();
    const after = await import('./composer-drafts');
    expect([...after.composerDrafts]).toEqual([['host-1/s-1', { revision: 0, text: 'half a thought' }]]);

    after.discardComposerDraft('host-1/s-1');
    vi.resetModules();
    expect((await import('./composer-drafts')).composerDrafts.size).toBe(0);
  });

  it('start empty from storage they can’t read', async () => {
    localStorage.setItem('weave.composerDrafts', '{not json');
    expect((await import('./composer-drafts')).composerDrafts.size).toBe(0);
  });
});
