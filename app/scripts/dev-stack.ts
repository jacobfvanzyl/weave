/// <reference types="bun" />
// A dev Dispatcher with a dev Host joined to it, for trying the app by hand in a simulator or with
// `bun run mac:dev`, away from the person's own Dispatcher and Hosts (WVE-221). It prints the URL
// and a code to pair with, and runs until it's interrupted. The Host's agent is the fake one, and
// its directory is a temporary one.
//
//   bun scripts/dev-stack.ts
//
// Build the debug `weave`, fake agent and holder first
// (`cargo build -p weave-cli -p weave-fake-agent -p weave-holder`).
import { startDevDispatcher } from '../src/host/testing/dev-dispatcher';
import { startDevHost } from '../src/host/testing/dev-host';

const [dispatcher, host] = await Promise.all([startDevDispatcher(), startDevHost()]);
await dispatcher.join(host, 'dev');
console.log(`url ${dispatcher.url}`);
console.log(`code ${await dispatcher.offer()}`);
console.log(`directory ${host.cwd}`);

const stop = async () => {
  await host.stop();
  await dispatcher.stop();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
await new Promise(() => {});
