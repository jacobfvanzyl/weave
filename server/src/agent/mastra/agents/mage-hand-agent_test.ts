import { assert, assertEquals } from 'jsr:@std/assert@1';
import { __mageHandAgentTest } from './mage-hand-agent.ts';

Deno.test('toolKeysForContext suppresses ask_user during an accepted Ask resume', () => {
  const requestContext = {
    get(key: string) {
      if (key === 'weave.askUserResume') return true;
      return undefined;
    },
  };

  const keys = __mageHandAgentTest.toolKeysForContext(requestContext);

  assertEquals(keys.has('ask_user'), false);
  assert(keys.has('webSearch'));
  assert(keys.has('renameThreadTool'));
});
