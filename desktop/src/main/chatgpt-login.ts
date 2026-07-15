import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { RpcRequestParams, RpcRequestResult } from "@weave/protocol";

export type ChatGPTAuthStatus = RpcRequestResult<
  "client",
  "server",
  "agent.chatgpt.login.complete"
>;

type ChatGPTLoginBrokerOptions = {
  startLogin: () => Promise<
    RpcRequestResult<"client", "server", "agent.chatgpt.login.start">
  >;
  completeLogin: (
    params: RpcRequestParams<
      "client",
      "server",
      "agent.chatgpt.login.complete"
    >,
  ) => Promise<
    RpcRequestResult<"client", "server", "agent.chatgpt.login.complete">
  >;
  openExternal: (url: string) => Promise<void>;
  host?: string;
  port?: number;
  now?: () => number;
};

const successHtml =
  '<!doctype html><html><head><meta charset="utf-8"><title>ChatGPT Connected</title></head><body><h1>ChatGPT Connected</h1><p>You can close this window and return to Weave.</p><script>setTimeout(() => window.close(), 1200)</script></body></html>';

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const failureHtml = (message: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>ChatGPT Login Failed</title></head><body><h1>ChatGPT Login Failed</h1><p>${
    escapeHtml(message)
  }</p></body></html>`;

export class ChatGPTLoginBroker {
  private readonly host: string;
  private readonly port: number;
  private readonly now: () => number;
  private inFlight: Promise<ChatGPTAuthStatus> | undefined;
  private abortActive: (() => void) | undefined;

  constructor(private readonly options: ChatGPTLoginBrokerOptions) {
    this.host = options.host ?? "127.0.0.1";
    this.port = options.port ?? 1455;
    this.now = options.now ?? Date.now;
  }

  connect(): Promise<ChatGPTAuthStatus> {
    if (this.inFlight) return this.inFlight;
    const attempt = this.runAttempt();
    const tracked = attempt.finally(() => {
      if (this.inFlight === tracked) this.inFlight = undefined;
    });
    this.inFlight = tracked;
    return tracked;
  }

  dispose() {
    this.abortActive?.();
  }

  private runAttempt(): Promise<ChatGPTAuthStatus> {
    return new Promise((resolve, reject) => {
      let server: Server | undefined;
      let timeout: NodeJS.Timeout | undefined;
      let expectedState: string | undefined;
      let settled = false;

      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        timeout = undefined;
        this.abortActive = undefined;
        server?.close();
      };
      const finish = (error?: unknown, status?: ChatGPTAuthStatus) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        } else if (status) resolve(status);
        else reject(new Error("ChatGPT login ended without a result."));
      };
      this.abortActive = () =>
        finish(
          new Error("ChatGPT login was cancelled because Weave is closing."),
        );

      server = createServer((request, response) => {
        void (async () => {
          const url = new URL(
            request.url ?? "/",
            `http://${this.host}:${this.port}`,
          );
          if (request.method !== "GET" || url.pathname !== "/auth/callback") {
            response.writeHead(404, {
              "content-type": "text/plain; charset=utf-8",
            });
            response.end("Not found");
            return;
          }

          const providerError = url.searchParams.get("error_description") ??
            url.searchParams.get("error");
          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state");
          try {
            if (providerError) throw new Error(providerError);
            if (!code || !state) {
              throw new Error(
                "OpenAI callback did not include code and state.",
              );
            }
            if (!expectedState || state !== expectedState) {
              throw new Error(
                "OpenAI callback state did not match this login attempt.",
              );
            }

            const completion = await this.options.completeLogin({
              code,
              state,
            });
            response.writeHead(200, {
              "content-type": "text/html; charset=utf-8",
            });
            response.end(successHtml);
            finish(undefined, completion);
          } catch (error) {
            const message = error instanceof Error
              ? error.message
              : String(error);
            response.writeHead(400, {
              "content-type": "text/html; charset=utf-8",
            });
            response.end(failureHtml(message));
            finish(error);
          }
        })();
      });

      server.once("error", (error) =>
        finish(
          error instanceof Error && "code" in error &&
            error.code === "EADDRINUSE"
            ? new Error(
              `Port ${this.port} is already in use. Close the other ChatGPT login or Codex process and try again.`,
            )
            : error,
        ));
      server.listen(this.port, this.host, () => {
        void (async () => {
          try {
            const address = server?.address() as AddressInfo | null;
            if (!address) {
              throw new Error("Desktop callback listener did not start.");
            }
            const login = await this.options.startLogin();
            expectedState = login.state;
            const remainingMs = login.expiresAt - this.now();
            if (remainingMs <= 0) {
              throw new Error(
                "ChatGPT login expired before the browser could open.",
              );
            }
            timeout = setTimeout(
              () => finish(new Error("ChatGPT login timed out. Try again.")),
              remainingMs,
            );
            await this.options.openExternal(login.url);
          } catch (error) {
            finish(error);
          }
        })();
      });
    });
  }
}
