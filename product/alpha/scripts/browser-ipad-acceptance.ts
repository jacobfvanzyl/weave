import { join } from 'node:path';

/** Launch only the existing Weave app, preserving its container and pairings. */
export async function runIPadBrowserAcceptance(root: string, device: string, durationMs: number) {
  const bundle = 'com.veezee.alpha';
  const command = async (args: string[], optional = false) => {
    const child = Bun.spawn(['xcrun', 'devicectl', ...args, '--quiet'], { stdout:'pipe', stderr:'pipe' });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code && !optional) throw new Error(`iPad acceptance command failed: ${err || out}`);
    return code === 0;
  };
  const copy = (direction: 'to'|'from', source: string, destination: string, optional = false) => command(['device','copy',direction,'--device',device,'--domain-type','appDataContainer','--domain-identifier',bundle,'--source',source,'--destination',destination], optional);
  await copy('to',join(root,'input.json'),'Documents/host-acceptance-input.json');
  const env = { ...(process.env.WEAVE_BROWSER_RESPONSIVE_DATA ? {WEAVE_BROWSER_RESPONSIVE_DATA:process.env.WEAVE_BROWSER_RESPONSIVE_DATA}:{}), ...(process.env.WEAVE_BROWSER_METAL_VERIFY ? {WEAVE_BROWSER_METAL_VERIFY:process.env.WEAVE_BROWSER_METAL_VERIFY} : {}), ...(process.env.WEAVE_BROWSER_METAL_FAILURE ? {WEAVE_BROWSER_METAL_FAILURE:process.env.WEAVE_BROWSER_METAL_FAILURE} : {}), ...(process.env.WEAVE_BROWSER_METAL ? {WEAVE_BROWSER_METAL:process.env.WEAVE_BROWSER_METAL} : {}), WEAVE_BROWSER_DIAGNOSTICS:'1', WEAVE_BROWSER_FIXTURE_MARKERS:'1', ...(process.env.WEAVE_BROWSER_RFB_ENCODING ? {WEAVE_BROWSER_RFB_ENCODING:process.env.WEAVE_BROWSER_RFB_ENCODING} : {}) };
  await command(['device','process','launch','--device',device,'--terminate-existing','--environment-variables',JSON.stringify(env),bundle,'--host-acceptance','--browser-acceptance']);
  // The launch clears the previous result before entering its asynchronous driver.
  await Bun.sleep(3000);
  const deadline=Date.now()+durationMs+90000;
  let result: any;
  while (Date.now()<deadline) {
    if (await copy('from','Documents/shell-acceptance.json',join(root,'ipad-result.json'),true)) { result=await Bun.file(join(root,'ipad-result.json')).json(); break; }
    await Bun.sleep(1500);
  }
  await copy('from','Documents/acceptance-page.json',join(root,'ipad-page.json'),true);
  await copy('from','Documents/shell-acceptance.png',join(root,'ipad.png'),true);
  if (!result?.passed) throw new Error(`iPad browser acceptance failed: ${JSON.stringify(result)}`);
  let cleaned=false;
  for(let attempt=0;attempt<20;attempt++){
    if(await copy('from','Documents/native-smoke-cleanup.json',join(root,'ipad-cleanup.json'),true)){
      const cleanup=await Bun.file(join(root,'ipad-cleanup.json')).json();
      if(!cleanup.removed)throw new Error('iPad fixture pairing cleanup failed');
      cleaned=true;break;
    }
    await Bun.sleep(500);
  }
  if(!cleaned)throw new Error('iPad fixture pairing cleanup timed out');
  await copy('from','tmp/weave-browser-performance.json',join(root,'native-performance.json'));
  // Desktop wrapper uses a hosts array; keep one summary reader for both shells.
  await Bun.write(join(root,'result.json'),JSON.stringify(result));
}
