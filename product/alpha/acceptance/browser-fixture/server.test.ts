import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createBrowserFixtureServer } from './server';

describe('Alpha Browser acceptance fixture HTTP surface', () => {
  let server: ReturnType<typeof createBrowserFixtureServer>;
  let origin: string;

  beforeAll(() => {
    server = createBrowserFixtureServer({ hostname: '127.0.0.1', port: 0 });
    origin = `http://${server.hostname}:${server.port}`;
  });

  afterAll(() => server.stop(true));

  test('serves a deterministic interactive browser page', async () => {
    const response = await fetch(`${origin}/`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('<title>Alpha Browser Acceptance Fixture</title>');
    expect(html).toContain('data-fixture="alpha-browser-acceptance"');
    expect(html).toContain('id="fixture-state"');
  });

  test('exposes stable controls for the Apple host acceptance matrix', async () => {
    const html = await fetch(`${origin}/`).then((response) => response.text());

    expect(html).toContain('href="/page-2?source=fixture"');
    expect(html).toContain('id="push-state"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('type="file"');
    expect(html).toContain('href="/download.txt"');
    expect(html).toContain('id="request-geolocation"');
    expect(html).toContain('id="request-camera"');
    expect(html).toContain('id="request-notifications"');
    expect(html).toContain('id="control-input"');
    expect(html).toContain('id="control-apply"');
    expect(html).toContain('id="control-bottom"');
  });

  test('serves deterministic navigation, redirect, slow, and failure responses', async () => {
    const pageTwo = await fetch(`${origin}/page-2?source=fixture`);
    const redirected = await fetch(`${origin}/redirect`);
    const failure = await fetch(`${origin}/status/500`);
    const slowStartedAt = performance.now();
    const slow = await fetch(`${origin}/slow?ms=20`);

    expect(await pageTwo.text()).toContain('<title>Alpha Browser Fixture Page 2</title>');
    expect(redirected.url).toBe(`${origin}/page-2?source=redirect`);
    expect(failure.status).toBe(500);
    expect(await failure.text()).toBe('fixture failure');
    expect(await slow.text()).toBe('fixture slow response');
    expect(performance.now() - slowStartedAt).toBeGreaterThanOrEqual(15);
  });

  test('provides popup and frame-denial resources with explicit policy headers', async () => {
    const home = await fetch(`${origin}/`).then((response) => response.text());
    const popup = await fetch(`${origin}/popup`);
    const noFrame = await fetch(`${origin}/no-frame`);

    expect(home).toContain('<iframe src="/no-frame"');
    expect(await popup.text()).toContain('<title>Alpha Browser Popup Target</title>');
    expect(noFrame.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(noFrame.headers.get('x-frame-options')).toBe('DENY');
  });

  test('makes downloads and human-selected uploads observable', async () => {
    const download = await fetch(`${origin}/download.txt`);
    const form = new FormData();
    form.set('fixture-file', new File(['fixture upload'], 'fixture.txt', {
      type: 'text/plain',
    }));
    const upload = await fetch(`${origin}/upload`, { method: 'POST', body: form });

    expect(download.headers.get('content-disposition')).toBe(
      'attachment; filename="alpha-browser-fixture.txt"',
    );
    expect(await download.text()).toBe('Alpha Browser deterministic download\n');
    expect(upload.status).toBe(200);
    expect(await upload.json()).toEqual({
      name: 'fixture.txt',
      size: 14,
      type: 'text/plain',
    });
  });

  test('provides an observable cookie round trip for ephemeral-profile acceptance', async () => {
    const setCookie = await fetch(`${origin}/cookie/set`, { redirect: 'manual' });
    const readCookie = await fetch(`${origin}/cookie/read`, {
      headers: { cookie: 'weave_alpha_acceptance=fixture-value' },
    });

    expect(setCookie.status).toBe(303);
    expect(setCookie.headers.get('set-cookie')).toContain(
      'weave_alpha_acceptance=fixture-value; Path=/; SameSite=Lax',
    );
    expect(await readCookie.json()).toEqual({ present: true, value: 'fixture-value' });
  });
});
