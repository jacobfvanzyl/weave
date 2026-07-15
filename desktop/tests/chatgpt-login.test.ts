import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { ChatGPTLoginBroker } from "../src/main/chatgpt-login";

const reservePort = async () => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
};

describe("ChatGPTLoginBroker", () => {
  it("uses RPC for start and completion while retaining the loopback callback", async () => {
    const port = await reservePort();
    const calls: Array<{ method: string; params: unknown }> = [];
    const broker = new ChatGPTLoginBroker({
      port,
      startLogin: async () => {
        calls.push({ method: "agent.chatgpt.login.start", params: undefined });
        return {
          url:
            `http://127.0.0.1:${port}/auth/callback?code=one-time&state=state-1`,
          state: "state-1",
          expiresAt: Date.now() + 5_000,
        };
      },
      completeLogin: async (params) => {
        calls.push({ method: "agent.chatgpt.login.complete", params });
        return { connected: true, accountId: "account-1", expires: 123 };
      },
      openExternal: async (url) => {
        await fetch(url);
      },
    });
    await expect(broker.connect()).resolves.toEqual({
      connected: true,
      accountId: "account-1",
      expires: 123,
    });
    expect(calls).toEqual([
      { method: "agent.chatgpt.login.start", params: undefined },
      {
        method: "agent.chatgpt.login.complete",
        params: { code: "one-time", state: "state-1" },
      },
    ]);
  });

  it("rejects a mismatched callback state before completion RPC", async () => {
    const port = await reservePort();
    const methods: string[] = [];
    const broker = new ChatGPTLoginBroker({
      port,
      startLogin: async () => {
        methods.push("agent.chatgpt.login.start");
        return {
          url:
            `http://127.0.0.1:${port}/auth/callback?code=one-time&state=wrong`,
          state: "expected",
          expiresAt: Date.now() + 5_000,
        };
      },
      completeLogin: async (params) => {
        methods.push("agent.chatgpt.login.complete");
        return { connected: true, accountId: params.code };
      },
      openExternal: async (url) => {
        await fetch(url);
      },
    });
    await expect(broker.connect()).rejects.toThrow(/state did not match/);
    expect(methods).toEqual(["agent.chatgpt.login.start"]);
  });
});
