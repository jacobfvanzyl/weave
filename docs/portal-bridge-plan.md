# Portal Bridge Plan

## Glossary

- **Plane**: server-owned project/repo context. Can exist without any connected local daemon.
- **Demiplane**: concrete workspace for a Plane thread. Usually a git worktree. Can be virtual while no Portal is connected.
- **Portal**: local/cloud daemon that connects outward to the Mastra server and executes filesystem/shell tools.

## Goals

- Keep plain non-Plane threads working with zero Portals connected.
- Let users create and discuss Planes before any Portal is connected.
- Let Mage Hand call `read`, `write`, `edit`, and `bash` against a remote laptop/sandbox once a Portal is connected.
- Keep server authoritative for user state, Planes, Demiplanes, thread bindings, and history.
- Keep Portal as executor only: local config cache + outbound connection + tool execution.

## High-level architecture

```text
Frontend
  ├─ plain threads
  └─ Planes
      └─ Plane threads
          └─ Demiplanes

Mastra server
  ├─ chat + memory
  ├─ Plane/Demiplane persistence
  ├─ Portal registry/presence
  ├─ tool router
  └─ audit log

Deno Portal daemon
  ├─ outbound websocket to server
  ├─ mounted Plane paths
  ├─ tool executor: read/write/edit/bash
  └─ git/worktree manager
```

## Current implemented slice

- `src/mastra/routes/planes.ts`
  - `GET /planes`
  - `POST /planes`
  - `GET /planes/:planeId`
  - `POST /planes/:planeId/threads`
  - placeholder `GET /portals`
  - placeholder `POST /portals/token`
- `src/mastra/routes/chat-state.ts`
  - hides internal Plane/Portal records from plain thread list
  - persists optional thread metadata: `planeId`, `demiplaneId`
- `src/mastra/tools/portal-tools.ts`
  - stub `read`, `write`, `edit`, `bash` tools returning offline Demiplane/Portal message
- `web/src/components/chat/ThreadSidebar.tsx`
  - Planes UI, Plane thread grouping, active outlines, collapsible cards

## Persistence model

Use same server persistence as threads. Server owns all canonical state.

### Plane

```ts
type Plane = {
  id: string;
  userId: string;
  name: string;
  description?: string;
  gitRemote?: string;
  defaultBranch?: string;
  rootPathHint?: string;
  demiplanes: Demiplane[];
  createdAt: string;
  updatedAt: string;
};
```

### Portal

```ts
type Portal = {
  id: string;
  userId: string;
  name: string;
  status: 'online' | 'offline';
  version?: string;
  capabilities: string[];
  lastSeenAt: string;
};
```

### PlaneMount

Links a server Plane to a local path on a Portal.

```ts
type PlaneMount = {
  id: string;
  planeId: string;
  portalId: string;
  localPath: string;
  gitRoot?: string;
  gitRemote?: string;
  defaultBranch?: string;
  status: 'mounted' | 'missing' | 'offline';
  createdAt: string;
  updatedAt: string;
};
```

### Demiplane

```ts
type Demiplane = {
  id: string;
  planeId: string;
  portalId?: string;
  mountId?: string;
  kind: 'main' | 'worktree' | 'sandbox' | 'virtual';
  name: string;
  path?: string;
  branch?: string;
  baseBranch?: string;
  threadId?: string;
  status: 'ready' | 'offline' | 'creating' | 'dirty' | 'missing' | 'virtual';
  createdAt: string;
  updatedAt: string;
};
```

### Thread binding

```ts
type ThreadBinding = {
  threadId: string;
  userId: string;
  planeId?: string;
  demiplaneId?: string;
  mode: 'plain' | 'plane';
};
```

## Portal daemon CLI

Target binary name: `mage-portal`.

```bash
mage-portal login --token mhb_xxx
mage-portal mount --plane plane_xxx --path ~/repo
mage-portal daemon
mage-portal status
```

Local config path:

```text
~/.mage-hand/portal.json
```

Example:

```json
{
  "portalId": "portal_macbook",
  "name": "Jaco MacBook",
  "serverUrl": "https://example.com",
  "token": "mhb_xxx",
  "mounts": [
    {
      "planeId": "plane_weave",
      "localPath": "/Users/jaco/Documents/VeeZee/weave"
    }
  ]
}
```

## Portal connection

Preferred: WebSocket route inside Mastra server if adapter supports upgrade.

Fallback: small sidecar WS server in same app/runtime, sharing registry/router modules.

Portal connects outward only. No inbound laptop ports.

### Hello

```json
{
  "type": "portal.hello",
  "portalId": "portal_macbook",
  "token": "mhb_xxx",
  "version": "0.1.0",
  "capabilities": ["read", "write", "edit", "bash", "git.worktree"],
  "mounts": []
}
```

## RPC protocol

### Tool call

```ts
type PortalRequest = {
  id: string;
  type: 'tool.call';
  portalId: string;
  planeId: string;
  demiplaneId: string;
  tool: 'read' | 'write' | 'edit' | 'bash' | 'git.status' | 'git.createWorktree';
  args: unknown;
  authz: {
    userId: string;
    threadId: string;
    agentId: string;
    scopes: string[];
  };
  deadlineMs?: number;
};
```

### Streaming update

```json
{
  "id": "req_123",
  "type": "tool.update",
  "stream": "stdout",
  "chunk": "..."
}
```

### Result

```ts
type PortalResponse = {
  id: string;
  type: 'tool.result';
  ok: boolean;
  result?: {
    content: Array<{ type: 'text'; text: string }>;
    details?: Record<string, unknown>;
  };
  error?: {
    code: string;
    message: string;
  };
};
```

## Tool semantics

Tools exposed to Mage Hand keep simple names:

- `read`
- `write`
- `edit`
- `bash`

Server injects current thread binding. Agent should not pass absolute local paths or IDs.

### read

Args:

```ts
{ path: string; offset?: number; limit?: number }
```

Rules:

- resolve relative to Demiplane root
- prevent path escape
- truncate output like Pi
- image support later

### write

Args:

```ts
{ path: string; content: string }
```

Rules:

- create parent dirs
- queue file mutations per absolute path
- audit mutation

### edit

Args:

```ts
{ path: string; edits: Array<{ oldText: string; newText: string }> }
```

Rules copied from Pi:

- `oldText` exact match
- each `oldText` unique in original file
- all edits matched against original content, not incrementally
- no overlapping edits
- return diff

### bash

Args:

```ts
{ command: string; timeout?: number }
```

Rules:

- cwd forced to Demiplane path
- allow all by default for v1
- default timeout 60s
- stream stdout/stderr
- truncate output
- kill process tree on timeout/abort
- audit command, exit code, thread, Plane, Demiplane

## Worktree flow

Default for implementation Plane thread once Portal online:

1. user creates Plane thread
2. server creates memory thread
3. server requests `git.createWorktree` from Portal
4. Portal runs equivalent of:

```bash
git worktree add ~/.mage-hand/worktrees/<plane>/<thread> -b mage/<thread-id> <baseBranch>
```

5. server stores Demiplane with path/branch/status
6. Mage Hand tools route to that Demiplane

If no Portal online:

- create thread normally
- create virtual Demiplane or no Demiplane
- tools return offline message

## Security and audit

Minimum v1 guardrails:

- explicit Plane mount registration
- server validates thread belongs to Plane/Demiplane before routing
- Portal validates Demiplane/mount belongs to local config
- path jail for read/write/edit
- per-file mutation queue
- bash cwd forced to Demiplane
- all mutations and bash calls audited
- short-lived copied token for Portal login

Future:

- OAuth/device login
- per-Plane tool policy
- approval prompts for risky commands
- `.env`/secret redaction
- signed daemon binary

## Implementation phases

### Phase 1: harden current Plane persistence

- Replace hidden memory-thread persistence with proper storage abstraction if Mastra custom tables are straightforward.
- Add update/delete Plane endpoints.
- Add Demiplane list/detail endpoints.
- Add Portal token listing/revocation.

### Phase 2: Deno Portal local core

- Create `portal/` Deno package.
- Implement config read/write.
- Implement CLI: `login`, `mount`, `daemon`, `status`.
- Implement local tools: `read`, `write`, `edit`, `bash`.
- Implement git helpers: status, create worktree.
- Add tests with temp directories/repos.

### Phase 3: server Portal registry

- Add Portal connection endpoint.
- Maintain online Portal connection map.
- Validate copied token.
- Handle hello/presence/mount sync.
- Add request/response correlation and timeouts.

### Phase 4: tool router

- Replace offline stubs in `portal-tools.ts` with router calls.
- Load current thread binding from context/memory.
- Route to online Portal by Demiplane.
- Return offline errors when no Portal/Demiplane available.

### Phase 5: worktree automation

- On Plane thread creation with online mount, create Demiplane worktree by default.
- Store Demiplane status/path/branch.
- Surface Demiplane status in UI.

### Phase 6: polish

- Portal management UI.
- Mount Plane to Portal flow.
- Audit viewer.
- Better error states and retry/reconnect behavior.
