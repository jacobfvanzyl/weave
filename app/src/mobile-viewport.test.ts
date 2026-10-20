import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('mobile viewport', () => {
  it('prevents iOS from magnifying the compact composer when it receives focus', async () => {
    const html = await readFile(resolve(process.cwd(), 'index.html'), 'utf8');
    const document = new DOMParser().parseFromString(html, 'text/html');
    const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');

    expect(viewport?.content).toContain('minimum-scale=1.0');
    expect(viewport?.content).toContain('maximum-scale=1.0');
    expect(viewport?.content).toContain('user-scalable=no');
  });
});
