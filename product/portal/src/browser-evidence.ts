import { dirname, join } from 'jsr:@std/path@1.1.2';
import type { BrowserScreenshotArtifact } from '@weave/product-protocol';
import type { BrowserControlAuditEvent, BrowserControlBrokerOptions } from './browser-control.ts';

const artifactScheme = 'weave-browser-artifact://';

export class BrowserControlEvidenceStore {
  readonly #auditPath: string;
  readonly #artifactDirectory: string;

  constructor(
    readonly stateDirectory: string,
    readonly now: () => Date = () => new Date(),
    readonly artifactLifetimeMs = 5 * 60_000,
    readonly maximumAuditBytes = 1024 * 1024,
  ) {
    this.#auditPath = join(stateDirectory, 'browser-control-audit.jsonl');
    this.#artifactDirectory = join(stateDirectory, 'browser-artifacts');
    void Deno.mkdir(this.#artifactDirectory, { recursive: true, mode: 0o700 })
      .then(() => this.#removeExpiredArtifacts())
      .catch(() => undefined);
  }

  brokerOptions(): BrowserControlBrokerOptions {
    return {
      audit: (event) => this.audit(event),
      externalizeScreenshot: (data, metadata) => this.storeScreenshot(data, metadata.requestId),
    };
  }

  audit(event: BrowserControlAuditEvent) {
    Deno.mkdirSync(dirname(this.#auditPath), { recursive: true, mode: 0o700 });
    try {
      if (Deno.statSync(this.#auditPath).size >= this.maximumAuditBytes) {
        const rotated = `${this.#auditPath}.1`;
        try {
          Deno.removeSync(rotated);
        } catch (cause) {
          if (!(cause instanceof Deno.errors.NotFound)) throw cause;
        }
        Deno.renameSync(this.#auditPath, rotated);
        Deno.chmodSync(rotated, 0o600);
      }
    } catch (cause) {
      if (!(cause instanceof Deno.errors.NotFound)) throw cause;
    }
    Deno.writeTextFileSync(this.#auditPath, `${JSON.stringify(event)}\n`, {
      append: true,
      create: true,
      mode: 0o600,
    });
    Deno.chmodSync(this.#auditPath, 0o600);
  }

  async storeScreenshot(data: Uint8Array, requestId: string): Promise<BrowserScreenshotArtifact> {
    await Deno.mkdir(this.#artifactDirectory, { recursive: true, mode: 0o700 });
    await this.#removeExpiredArtifacts();
    const artifactId = `${requestId}-${crypto.randomUUID()}`;
    const path = join(this.#artifactDirectory, `${artifactId}.png`);
    await Deno.writeFile(path, data, { createNew: true, mode: 0o600 });
    await Deno.chmod(path, 0o600);
    setTimeout(() => void Deno.remove(path).catch(() => undefined), this.artifactLifetimeMs);
    return {
      uri: `${artifactScheme}${artifactId}`,
      sizeBytes: data.byteLength,
      expiresAt: new Date(this.now().getTime() + this.artifactLifetimeMs).toISOString(),
    };
  }

  async #removeExpiredArtifacts() {
    const cutoff = this.now().getTime() - this.artifactLifetimeMs;
    try {
      for await (const entry of Deno.readDir(this.#artifactDirectory)) {
        if (!entry.isFile || !entry.name.endsWith('.png')) continue;
        const path = join(this.#artifactDirectory, entry.name);
        const info = await Deno.stat(path);
        if (info.mtime && info.mtime.getTime() < cutoff) await Deno.remove(path);
      }
    } catch (cause) {
      if (!(cause instanceof Deno.errors.NotFound)) throw cause;
    }
  }
}
