# Switching Weave from pnpm to Bun

_Research snapshot: 2026-07-31. Primary sources only; repository inspection and disposable local probes used for Weave-specific conclusions._

## Answer

Yes, Weave can move from pnpm to Bun as its **Node package manager and root script runner**, while keeping Node as the runtime for Electron/Vite CLIs and Deno as the runtime for the server, Portal, TUI, and protocol checks.

It should not be treated as a lockfile-only replacement. The package graph is compatible, but three Weave-specific seams make this a staged migration:

1. the current pnpm-to-Bun lock migration fails on Electron Forge's GitHub-pinned `@electron/node-gyp` dependency under the locally installed Bun 1.3.14;
2. Electron Forge does not currently list Bun among its officially supported package managers and is sensitive to `node_modules` layout; and
3. the server image relies on `pnpm deploy`, for which Bun has no equivalent documented deployment command.

The recommendation is therefore **yes, via a narrow migration branch with explicit desktop, iOS, Deno, image, and live deploy gates**. Do not remove `pnpm-lock.yaml` until all of those gates pass.

## What Bun covers directly

Bun now covers most of the package-manager model Weave uses:

| Weave construct | Bun status | Required migration |
| --- | --- | --- |
| npm-style workspaces and `workspace:*` | Supported. Bun links local workspace packages and filters installs/scripts by workspace name or path. ([Bun workspaces](https://bun.sh/docs/pm/workspaces), [filtering](https://bun.sh/docs/pm/filter)) | Keep all six current workspace globs/packages, but consolidate them into Bun's root `workspaces` form. |
| `catalog:` dependencies | Supported, including default and named catalogs. Bun defines them under the root `workspaces` object. ([Bun catalogs](https://bun.sh/docs/pm/catalogs)) | Move the current catalog into `workspaces.catalog`; remove the duplicate top-level `catalog` after verifying the generated graph. |
| top-level override for `@blocksuite/icons` | Supported through root `overrides`; nested overrides are not supported. Weave only has a top-level override. ([Bun overrides](https://bun.sh/docs/pm/overrides)) | Move the existing override from `pnpm-workspace.yaml` to root `package.json`. |
| patched dependencies | Supported through `patchedDependencies`, and Bun's pnpm migration preserves patch integrity metadata. Weave currently has no patches. ([Bun patch](https://bun.sh/docs/pm/cli/patch), [pnpm migration](https://bun.sh/docs/pm/cli/install#pnpm-migration)) | No current product change; retain the capability for future patches. |
| frozen/reproducible installs | `bun ci` is equivalent to `bun install --frozen-lockfile`; both require a committed `bun.lock`. ([Bun CI and frozen installs](https://bun.sh/docs/pm/cli/install#ci-cd)) | Commit one root `bun.lock`, use `bun ci` in CI/images, and keep the Deno lockfiles as separate runtime locks. |
| isolated dependency layout | Bun's pnpm migration selects `configVersion = 1`, which defaults workspaces to the pnpm-like isolated linker under `node_modules/.bun`. ([Bun isolated installs](https://bun.sh/docs/pm/isolated-installs)) | Start isolated to preserve dependency strictness; move to hoisted only if Electron packaging evidence requires it. |
| root and workspace scripts | Bun can filter scripts by name/path and respects dependency order. By default, JavaScript CLIs with a `#!/usr/bin/env node` shebang still run under Node unless `--bun` is explicitly supplied. ([Bun filtering](https://bun.sh/docs/pm/filter), [Bun runtime and `--bun`](https://bun.sh/docs/runtime#bun)) | Replace pnpm filter invocations with Bun filter invocations, but do not force Electron Forge, Capacitor, or Vite onto the Bun runtime in the first migration. |

Bun's documented pnpm migration requires lockfile version 7 or newer, converts the lock graph, copies workspace packages/catalogs into `package.json`, moves overrides and patched dependencies, and preserves `catalog:` references. Weave's lockfile is version 9, so it meets the format requirement. ([Bun pnpm migration](https://bun.sh/docs/pm/cli/install#pnpm-migration))

## Weave configuration that does not translate one-for-one

`pnpm-workspace.yaml` also encodes policy, not just dependency versions:

- `pmOnFail`, `verifyDepsBeforeRun`, `disallowWorkspaceCycles`, `injectWorkspacePackages`, `strictDepBuilds`, `enableGlobalVirtualStore`, `publicHoistPattern`, and `blockExoticSubdeps` do not have direct Bun fields documented under the install configuration.
- `allowBuilds` maps conceptually to Bun's lifecycle trust model, but the semantics differ.
- `pnpm deploy` is a pnpm-specific production-assembly step and is the largest operational gap.

These settings must be classified individually as either unnecessary under Bun's model, replaced by a Bun setting, or retained as an explicit repository validation. They should not silently disappear as part of deleting `pnpm-workspace.yaml`.

## Lifecycle scripts and trust

Bun runs the root project's install/prepare lifecycle scripts, but does not run arbitrary dependency lifecycle scripts by default. Dependencies can be allowed through `trustedDependencies`; `bun pm untrusted`, `bun pm trust`, and `bun pm default-trusted` expose and manage the policy. Bun also ships a default trust list for common packages. ([Bun lifecycle scripts](https://bun.sh/docs/pm/lifecycle), [Bun package-manager utilities](https://bun.sh/docs/pm/cli/pm))

That has two immediate consequences for Weave:

1. `preinstall: node scripts/ensure-pnpm.mjs` will deliberately reject Bun and must be replaced with a Bun version guard or removed in the same commit that changes `packageManager`.
2. The pnpm `allowBuilds` list (`esbuild`, `fs-xattr`, `fsevents`, `macos-alias`) cannot simply be copied mechanically. A clean Bun install should be followed by `bun pm untrusted`; only packages whose scripts are actually necessary should be committed to `trustedDependencies`.

On local Bun 1.3.14, `electron`, `esbuild`, `fs-xattr`, and `macos-alias` appeared in Bun's default-trusted list, and the clean Weave manifest probe reported zero untrusted dependencies after installation. This is useful evidence, but the committed policy should still be explicit enough to reproduce in CI and on every supported OS.

## Electron and Electron Forge

This is the highest-risk developer surface.

Electron Forge 7.11.2's official prerequisites list npm, Yarn, and pnpm, but not Bun. Forge also says packaging crawls an on-disk `node_modules` tree using a naive resolver that does not account for symlinked dependencies, and specifically recommends a hoisted linker for pnpm. ([Electron Forge getting started](https://www.electronforge.io/)) Bun's isolated linker is intentionally symlink-based and pnpm-like. ([Bun isolated installs](https://bun.sh/docs/pm/isolated-installs))

This is not proof that Bun fails: in the disposable clean install, Bun created the package-local paths that Weave's scripts expect (`desktop/node_modules/electron` and `desktop/node_modules/@electron/osx-sign`), and Forge's CLI reported version 7.11.2 when launched with Node. It does mean that only a real `start`, `package`, signed package, and `make` run can establish compatibility. If packaging cannot crawl the isolated layout, the first controlled fallback is a hoisted Bun linker rather than changing application code.

Electron's current binary model is compatible with Weave's existing preparation script. Electron documents that the native binary is downloaded on first development launch, or explicitly through the included `install-electron` command. ([Electron installation](https://www.electronjs.org/docs/latest/tutorial/installation)) `desktop/scripts/prepare-signed-electron-dev.mjs` already detects a missing binary and runs `electron/install.js` before signing it. Its pnpm-specific error text still needs updating.

Native addons remain a release gate. Electron uses a different ABI and recommends `@electron/rebuild`; Forge invokes it automatically in development and packaging. ([Electron native modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules/)) The current Forge graph contains a GitHub-pinned Electron fork of `node-gyp`, which is also the dependency that exposed the automatic lock-migration failure described below.

## Deno server, Portal, and TUI

Deno is not a blocker to using Bun as the installer. In `nodeModulesDir: "manual"`, Deno explicitly supports a `node_modules` tree created by npm, pnpm, or any other package manager. It supports both isolated and hoisted layouts, and native Node-API addons when a local tree exists and `--allow-ffi` is granted. ([Deno Node/npm compatibility](https://docs.deno.com/runtime/fundamentals/node/))

The clean Bun isolated install also preserved the crucial workspace shape:

- `server/node_modules/@weave/protocol` linked to `../../../packages/protocol`;
- the real TypeScript source therefore remained outside `node_modules`;
- package-local `node_modules` directories still existed for server and shared packages.

That matches the development shape required by Weave's existing workaround for Deno's refusal to strip TypeScript types from a package physically placed below `node_modules`. It still needs to be confirmed by `deno task server:build`, server tests, and a production image.

The Deno locks should remain. Bun owns the Node dependency installation lock; `server/deno.lock`, `portal/deno.lock`, `tui/deno.lock`, and the root Deno lock continue to pin Deno's runtime resolution and should still be checked with Deno's frozen mode.

### Server image and deploy gap

The current `server/Dockerfile` does two pnpm-specific things:

1. filtered frozen installation of `weave-server...`; and
2. `pnpm --filter weave-server --prod deploy /prod/server`, which creates the self-contained tree copied into the Deno runner.

Bun documents filtered installs and production omission, plus `bun pm pack`, but its package-manager utility surface does not document a `deploy` equivalent. ([Bun install](https://bun.sh/docs/pm/cli/install), [Bun filtering](https://bun.sh/docs/pm/filter), [Bun PM utilities](https://bun.sh/docs/pm/cli/pm)) The Dockerfile must therefore be redesigned and verified rather than translated command-for-command. A likely pilot is a filtered production install followed by an explicit copy of the root `.bun` store, server package-local links, server sources, and `packages/protocol`, but the exact output tree must be proved inside the Deno runner.

Because `scripts/dokploy-server.ts` snapshots every Docker build input, the Bun lock/config and any replacement guard must also replace the pnpm paths in its allowlist and tests. A local image build is not sufficient: the final gate is the supported `deno task server:deploy` path plus remote health and startup-log verification.

## Capacitor, iOS SPM, and Vite

Capacitor 8.4.1's own migration source explicitly offers Bun as a dependency installer. ([Capacitor 8.4.1 migrator source](https://github.com/ionic-team/capacitor/blob/8.4.1/cli/src/tasks/migrate.ts)) Its SPM generator emits each plugin's resolved `rootPath` into `CapApp-SPM/Package.swift`. ([Capacitor 8.4.1 SPM generator](https://github.com/ionic-team/capacitor/blob/8.4.1/cli/src/util/spm.ts))

Weave's checked-in `mobile/ios/App/CapApp-SPM/Package.swift` currently contains four physical `.pnpm/...` paths. After Bun installation, `cap sync ios` must regenerate this file to `.bun/...` paths (or configured stable symlinks), and the result must be validated with an Xcode/SPM build. This generated native file is a required migration artifact, not stale text to replace by hand.

For Vite, Bun's own guide states that Vite's Node shebang is respected by default; `--bun` is required to force the Vite CLI onto Bun's runtime. ([Bun's Vite guide](https://bun.sh/docs/guides/ecosystem/vite)) Keeping the default Node runtime makes the package-manager migration smaller and preserves Weave's current Vite environment semantics. Runtime migration can be considered separately later.

## Disposable Bun 1.3.14 probes against the current manifests

No product/config files were changed by these probes. Manifests and the current pnpm lock were copied to temporary directories.

### Probe A: automatic pnpm migration

`bun pm migrate` completed in about 240 ms and:

- generated a text `bun.lock` with `configVersion = 1`;
- converted `workspaces` from an array to an object containing `packages` and `catalog`;
- added the `@blocksuite/icons` override to root `package.json`;
- preserved the current resolved Electron version 42.6.1.

However, the resulting install failed on:

```text
Integrity check failed for tarball: @electron/node-gyp
failed to download @electron/node-gyp@github:electron/node-gyp#06b29a...
```

The pnpm lock identifies that dependency by a `codeload.github.com` tarball plus integrity, while the migrated Bun lock normalizes it to a GitHub dependency. Bun then fetched a different GitHub tarball representation and rejected it against the migrated integrity. This makes the documented automatic migration unusable as-is for the current Forge 7.11.2 graph.

### Probe B: fresh Bun resolution from the transformed manifests

A fresh lock generated without importing `pnpm-lock.yaml` installed successfully with the isolated linker:

```text
bun install --frozen-lockfile --linker isolated
2875 packages installed
```

Additional observations:

- Forge 7.11.2's CLI launched under Node.
- package-local Electron, signing, Capacitor, and workspace links were present.
- the Electron binary downloaded successfully on demand through Electron's own installer.
- `bun pm untrusted` reported zero blocked dependencies with scripts.
- the server-to-protocol workspace link remained outside `node_modules` physically.

But a fresh resolution did **not** preserve every pnpm-resolved version: for example, compatible ranges selected React 19.2.8 instead of 19.2.7 and Capacitor core 8.4.2 instead of 8.4.1. A fresh lock is therefore dependency churn, not a pure package-manager migration.

The implementation must choose deliberately between repairing the one migrated Git dependency while preserving all other pins, or generating a fresh lock and reviewing every changed direct/transitive version. The first option is preferable for a narrow migration if Bun can encode the dependency without an unstable hand-edited lockfile.

## Recommended migration sequence

1. **Create a migration branch and record the current graph.** Capture pnpm install, Deno checks, desktop start/package/make, web build, mobile sync/Xcode build, and server image/deploy baselines.
2. **Translate root package metadata.** Pin the tested Bun version in `packageManager`, move workspace packages/catalog and override into Bun's supported root shape, replace the pnpm preinstall guard, and translate root/package scripts without adding `--bun`.
3. **Resolve the lockfile blocker without hidden dependency churn.** Start from Bun's pnpm migration, isolate the `@electron/node-gyp` integrity issue, and compare every resolved package to the pnpm lock. Do not accept a fresh graph silently.
4. **Adopt explicit install policy.** Begin with `linker = "isolated"`, run `bun pm untrusted`, commit only required trust entries, and use `bun ci` as the frozen install gate.
5. **Validate shells independently.** Run web/client tests and builds; full Electron start, smoke, signed package, and maker flows; Capacitor sync plus Xcode/SPM build; Deno server build/tests; Portal/TUI checks.
6. **Rebuild the production dependency assembly.** Replace `pnpm deploy` with a proved Bun production tree, update Docker cache/input paths and deploy snapshot tests, then build and run the Deno image locally.
7. **Deploy through the real Weave path.** Run the supported headless server deployment, verify remote Deno startup, health endpoints, and the protocol workspace link in the image.
8. **Only then remove pnpm.** Delete `pnpm-lock.yaml`, `pnpm-workspace.yaml`, and `scripts/ensure-pnpm.mjs`; update the snapshot allowlist, generated SPM file, scripts, docs, AGENTS files, and remaining user-facing pnpm text. Keep incidental historical/test fixture strings only when intentional.

## Acceptance bar

The switch is complete only when all of the following are true:

- a clean checkout installs with the pinned Bun version and `bun ci` on macOS and Linux;
- repeated frozen installs produce no manifest or lock diff;
- no required lifecycle script is blocked;
- Electron dev launch, smoke tests, signed package, and installer creation succeed from a clean Bun tree;
- web and mobile Vite builds succeed under their intended Node runtime;
- `cap sync ios` produces valid Bun-backed SPM paths and Xcode builds them;
- Deno server, Portal, TUI, and protocol checks pass using the Bun-created manual `node_modules` tree;
- the production server image starts with `@weave/protocol` outside `node_modules` physically;
- `deno task server:deploy` succeeds and remote health/log checks pass; and
- the repository has one Node dependency lock (`bun.lock`), no active pnpm-only config, and no accidental dependency-version drift.

## Bottom line

The ecosystem support is now sufficient to make the switch. The risk is concentrated and testable, not architectural: Electron Forge's unsupported installer/layout edge, one migrated Git dependency integrity mismatch, generated Capacitor paths, and replacing pnpm's deploy output. Keeping Node and Deno as the execution runtimes turns this into a manageable package-manager migration rather than a repo-wide runtime rewrite.

## Implementation result (2026-07-31)

The migration was implemented with Bun 1.3.14 while preserving the pnpm-resolved dependency graph. The automatically migrated `bun.lock` needed one canonical Bun resolution for Electron Forge's Git-pinned `@electron/node-gyp`; a clean frozen install then succeeded, and a repeated frozen install made no changes. `bun pm untrusted` reported no blocked lifecycle scripts after the required trust list was declared.

The workspace uses Bun's isolated linker and a narrow public hoist for `@types/node`, which Deno requires when checking the manual `node_modules` tree. The server image performs a filtered production install and preserves the workspace root in the Deno runner so `server/deno.lock` is validated in the same workspace context as development. An image build and an in-container `deno task build` both passed through the explicit `bazzite` Docker context.

The following gates passed from the Bun-created install tree:

- clean and repeated `bun install --frozen-lockfile`;
- server, Portal, TUI, protocol, deploy-helper, client, and desktop checks/tests;
- web and mobile builds plus Capacitor sync;
- Xcode Swift Package resolution and an unsigned iOS simulator build;
- Electron development launch, signed runtime preparation, packaging, ZIP creation, and DMG creation; and
- the production server image build plus an in-container Deno check.

The live `deno task server:deploy` gate was intentionally not run because it would change the shared development server. The repository migration is implemented and locally/offboard-build validated; live deployment remains a separate release action.
