# Full-stack acceptance harness

This harness exercises the production Desktop/shared-client boundary through a
real Deno server, JSON-RPC transport, isolated PostgreSQL database, and Portal
process. It owns every resource it creates and removes the exact temporary
Electron profiles, Portal home, Workspace fixture, and labeled PostgreSQL
container after each run.

Run the baseline locally from the repository root:

```bash
WEAVE_ACCEPTANCE_DOCKER_CONTEXT=bazzite \
bun --filter weave-desktop test:acceptance
```

`WEAVE_ACCEPTANCE_DOCKER_CONTEXT` defaults to `docker context show`. Unix-socket
contexts connect through `127.0.0.1`; SSH contexts tunnel the exact ephemeral
PostgreSQL port through the context endpoint. Set `WEAVE_ACCEPTANCE_DOCKER_HOST`
only when published container ports are directly reachable through a different
hostname.

CI needs Docker, Deno, Bun 1.3.14, Git, and a display supported by
Electron/Playwright (for example Xvfb on Linux). The same command can use the CI
runner's local Docker context without either override.
