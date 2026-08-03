# Full-stack acceptance harness

This harness starts the hardened Forge-packaged Desktop as a real RPC client,
then exercises the same production Vite bundles through two Playwright-driven
Desktop profiles against a real Deno server, JSON-RPC transport, isolated
PostgreSQL database, and Portal process. The shipped fuses intentionally disable
the inspection channel Playwright needs, so the packaged process is
health-checked through the server instead of instrumented. The harness owns
every resource it creates and removes the exact temporary Electron profiles,
Portal home, Workspace fixture, and labeled PostgreSQL container after each run.

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

CI needs Docker, Deno, Bun 1.3.14, Node 24 or 25 for Electron Forge, Git, and a
display supported by Electron/Playwright (for example Xvfb on Linux). The same
command can use the CI runner's local Docker context without either override.
The dedicated GitHub Actions workflow runs this baseline for every relevant pull
request.
