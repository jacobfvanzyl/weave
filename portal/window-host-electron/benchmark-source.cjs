const { app, BrowserWindow } = require('electron');
const readline = require('node:readline');

const title = 'Weave Native Stream Benchmark Source';
let window;

const writeJsonLine = (value) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const html = encodeURIComponent(`
<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
    <style>
      html, body, canvas {
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
        background: #101116;
      }
    </style>
  </head>
  <body>
    <canvas id="surface"></canvas>
    <script>
      const canvas = document.getElementById('surface');
      const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
      const resize = () => {
        canvas.width = Math.max(1, Math.floor(window.innerWidth * devicePixelRatio));
        canvas.height = Math.max(1, Math.floor(window.innerHeight * devicePixelRatio));
      };
      window.addEventListener('resize', resize);
      resize();
      let frame = 0;
      const draw = () => {
        frame += 1;
        const width = canvas.width;
        const height = canvas.height;
        context.fillStyle = '#101116';
        context.fillRect(0, 0, width, height);
        for (let index = 0; index < 10; index += 1) {
          const x = ((frame * (3 + index) + index * 97) % (width + 160)) - 160;
          const hue = (frame + index * 31) % 360;
          context.fillStyle = 'hsl(' + hue + ', 80%, 58%)';
          context.fillRect(x, index * height / 10, 160, Math.ceil(height / 12));
        }
        context.fillStyle = '#f4f7ff';
        context.font = Math.round(32 * devicePixelRatio) + 'px system-ui, sans-serif';
        context.fillText('60fps ScreenCaptureKit source ' + frame, 32 * devicePixelRatio, 56 * devicePixelRatio);
      };
      draw();
      setInterval(draw, 1000 / 60);
    </script>
  </body>
</html>
`);

const createWindow = async () => {
  await app.whenReady();
  window = new BrowserWindow({
    title,
    width: 960,
    height: 540,
    show: true,
    webPreferences: {
      backgroundThrottling: false,
    },
  });
  await window.loadURL(`data:text/html,${html}`);
  window.show();
  window.focus();
  window.moveTop();
  writeJsonLine({ type: 'ready', title });
};

const startCommandLoop = () => {
  const lines = readline.createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.type === 'shutdown') {
      writeJsonLine({ id: message.id, ok: true });
      app.quit();
    }
  });
};

app.whenReady().then(async () => {
  startCommandLoop();
  await createWindow();
}).catch((error) => {
  process.stderr.write(`[window-benchmark-source] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
