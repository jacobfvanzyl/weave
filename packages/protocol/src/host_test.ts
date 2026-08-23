import { assertEquals } from "jsr:@std/assert@1";
import {
  WEAVE_ACP_RUNTIME_STATE_NOTIFICATION,
  weaveAcpRuntimeRecoveryCapabilitySchema,
  weaveAcpRuntimeStateParamsSchema,
} from "./host.ts";

Deno.test("Weave ACP runtime recovery extension validates advertised state updates", () => {
  assertEquals(
    weaveAcpRuntimeRecoveryCapabilitySchema.parse({
      version: 1,
      stateNotification: WEAVE_ACP_RUNTIME_STATE_NOTIFICATION,
    }),
    {
      version: 1,
      stateNotification: "_weave.dev/runtime/state",
    },
  );
  assertEquals(
    weaveAcpRuntimeStateParamsSchema.parse({
      sessionId: "session-1",
      generation: 2,
      state: "uncertain",
      code: "PROMPT_UNCERTAIN",
    }).state,
    "uncertain",
  );
});
