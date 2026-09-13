import { isAbsolute } from 'node:path';
import { serveBrowserService } from './service.ts';

if (import.meta.main) {
  process.umask(0o077);
  const [stateDirectory, binary, cefBinary] = process.argv.slice(2);
  if (!stateDirectory || !isAbsolute(stateDirectory) || !binary || !isAbsolute(binary)) {
    throw new Error('Usage: bun browser-service/main.ts <absolute-state-directory> <absolute-chromium-binary>');
  }
  const service = await serveBrowserService({ stateDirectory, binary, cefBinary });
  console.log('Browser Service ready');
  const shutdown = () => void service.close().catch(error => { console.error(error); process.exitCode = 1; });
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
