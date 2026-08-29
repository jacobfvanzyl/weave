const html = (body: string, title: string) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${title}</title>
  </head>
  <body data-fixture="alpha-browser-acceptance">
    ${body}
  </body>
</html>`;

const fixturePage = html(`
    <main>
      <h1>Alpha Browser Acceptance Fixture</h1>
      <section>
        <a href="/page-2?source=fixture">Navigate to page 2</a>
        <button id="push-state" type="button">Push history state</button>
        <a href="/popup" target="_blank" rel="opener">Open popup</a>
      </section>
      <section>
        <form action="/upload" method="post" enctype="multipart/form-data">
          <label>Upload fixture file <input name="fixture-file" type="file"></label>
          <button type="submit">Submit upload</button>
        </form>
        <a href="/download.txt" download>Download fixture file</a>
      </section>
      <section>
        <button id="request-geolocation" type="button">Request geolocation</button>
        <button id="request-camera" type="button">Request camera</button>
        <button id="request-notifications" type="button">Request notifications</button>
      </section>
      <section><iframe src="/no-frame" title="Frame denial fixture"></iframe></section>
      <section>
        <label>Control value <input id="control-input" aria-label="Control value"></label>
        <button id="control-apply" type="button">Apply control value</button>
        <output id="control-result">control:idle</output>
        <div style="height:1200px" aria-hidden="true"></div>
        <button id="control-bottom" type="button">Bottom control target</button>
      </section>
    </main>
    <output id="fixture-state">ready</output>
    <script>
      const fixtureState = document.querySelector('#fixture-state');
      document.querySelector('#request-camera').addEventListener('click', async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
          stream.getTracks().forEach((track) => track.stop());
          fixtureState.textContent = 'permission:camera:granted';
        } catch (error) {
          fixtureState.textContent = 'permission:camera:denied:' + error.name;
        }
      });
      const controlInput = document.querySelector('#control-input');
      controlInput.addEventListener('keydown', (event) => {
        controlInput.dataset.lastKey = event.key;
      });
      document.querySelector('#control-apply').addEventListener('click', () => {
        setTimeout(() => {
          document.querySelector('#control-result').textContent =
            'control:applied:' + controlInput.value + ':key:' + (controlInput.dataset.lastKey || 'none');
        }, 50);
      });
      window.addEventListener('message', (event) => {
        if (event.data === 'alpha-browser-frame-rendered') {
          document.body.dataset.deniedFrameRendered = 'true';
        }
      });
    </script>
`, 'Alpha Browser Acceptance Fixture');

export function createBrowserFixtureServer({
  hostname = '0.0.0.0',
  port = 5175,
}: {
  hostname?: string;
  port?: number;
} = {}) {
  return Bun.serve({
    hostname,
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/') {
        return new Response(fixturePage, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      if (url.pathname === '/page-2') {
        return new Response(html(
          '<main><h1>Fixture Page 2</h1><a href="/">Return to fixture home</a></main>',
          'Alpha Browser Fixture Page 2',
        ), { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      if (url.pathname === '/redirect') {
        return Response.redirect(new URL('/page-2?source=redirect', url), 302);
      }
      if (url.pathname === '/popup') {
        return new Response(html(
          '<main><h1>Visible popup target</h1><p data-popup-policy="same-visible-session">popup target</p></main>',
          'Alpha Browser Popup Target',
        ), { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      if (url.pathname === '/no-frame') {
        return new Response(
          '<!doctype html><title>Alpha Browser Frame Denied</title><script>parent.postMessage("alpha-browser-frame-rendered", "*")</script>',
          {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy': "frame-ancestors 'none'",
            'x-frame-options': 'DENY',
          },
          },
        );
      }
      if (url.pathname === '/download.txt') {
        return new Response('Alpha Browser deterministic download\n', {
          headers: {
            'content-type': 'text/plain; charset=utf-8',
            'content-disposition': 'attachment; filename="alpha-browser-fixture.txt"',
          },
        });
      }
      if (url.pathname === '/upload') {
        if (request.method !== 'POST') {
          return new Response('Method not allowed', { status: 405 });
        }
        const form = await request.formData();
        const file = form.get('fixture-file');
        if (!(file instanceof File)) {
          return Response.json({ error: 'fixture-file is required' }, { status: 400 });
        }
        return Response.json({
          name: file.name,
          size: file.size,
          type: file.type.split(';', 1)[0],
        });
      }
      if (url.pathname === '/cookie/set') {
        return new Response(null, {
          status: 303,
          headers: {
            location: '/cookie/read',
            'set-cookie': 'weave_alpha_acceptance=fixture-value; Path=/; SameSite=Lax',
          },
        });
      }
      if (url.pathname === '/cookie/read') {
        const cookie = request.headers.get('cookie') ?? '';
        const value = cookie
          .split(';')
          .map((part) => part.trim().split('='))
          .find(([name]) => name === 'weave_alpha_acceptance')?.[1];
        return Response.json({ present: value !== undefined, value: value ?? null });
      }
      if (url.pathname === '/status/500') {
        return new Response('fixture failure', { status: 500 });
      }
      if (url.pathname === '/slow') {
        const requestedDelay = Number(url.searchParams.get('ms') ?? 1_000);
        const delay = Math.max(
          0,
          Math.min(5_000, Number.isFinite(requestedDelay) ? requestedDelay : 1_000),
        );
        return Bun.sleep(delay).then(() => new Response('fixture slow response'));
      }
      return new Response('Not found', { status: 404 });
    },
  });
}

if (import.meta.main) {
  const rawPort = Number(Bun.env.BROWSER_ACCEPTANCE_FIXTURE_PORT ?? 5175);
  const server = createBrowserFixtureServer({
    hostname: Bun.env.BROWSER_ACCEPTANCE_FIXTURE_HOST ?? '0.0.0.0',
    port: Number.isFinite(rawPort) ? rawPort : 5175,
  });
  console.log(`Alpha Browser acceptance fixture: ${server.url}`);
}
