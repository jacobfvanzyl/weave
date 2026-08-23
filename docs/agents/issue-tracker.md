# Issue tracker: Linear

Issues and PRDs for this repository live in the **Personal** Linear workspace
(`jacobfvanzyl`) under the **Weave** team (`WVE`).

Use the repository-pinned `@schpet/linear-cli` for all tracker operations. Do
not use a Linear plugin, MCP connector, PATH-resolved global binary, or an
unpinned `bunx` invocation.

## CLI and authentication

Install the pinned CLI from the repository root:

```bash
bun install --cwd .agents/tools/linear --frozen-lockfile
```

Use this complete command prefix for every Linear operation:

```bash
env -u LINEAR_API_KEY .agents/tools/linear/node_modules/.bin/linear
```

The repository's secret-free `.linear.toml` identifies workspace
`jacobfvanzyl` and team `WVE`. Credentials come only from the existing macOS
Keychain profile for `jacobfvanzyl`.

- Keep `LINEAR_API_KEY` unset for every invocation, including reads.
- Never add `api_key` to `.linear.toml` or another repository file.
- Never call `linear auth token`; it prints the resolved secret.
- Never change the default workspace to operate this repository.
- Do not log out, overwrite, or otherwise disturb another stored workspace
  profile.
- Pass `--workspace jacobfvanzyl` explicitly on every operation.
- Before the first tracker operation in a task, verify the selected identity:

  ```bash
  env -u LINEAR_API_KEY .agents/tools/linear/node_modules/.bin/linear \
    --workspace jacobfvanzyl auth whoami
  ```

Fail closed unless the command reports workspace **Personal**, slug
`jacobfvanzyl`, and the intended Personal account.

## Conventions

- **Create an issue:** Use `issue create --team WVE --title "..."
  --description-file <path> --no-interactive`.
- **Read an issue:** Use `issue view WVE-123 --json`, including comments and
  labels when relevant.
- **List issues:** Use `issue query --team WVE --json`; inspect `pageInfo` and
  count `.nodes` because the result is an object rather than an array.
- **Resolve statuses:** Use `team states WVE --json`. In CLI 2.3.0 the team key
  is positional.
- **Comment on an issue:** Use `issue comment add WVE-123 --body-file <path>`.
- **Apply or remove labels:** Use `docs/agents/triage-labels.md`. Fetch the
  complete current label set first because `issue update --label` replaces the
  label set rather than adding one label.
- **Close an issue:** Resolve the canonical completed or canceled state through
  `team states WVE --json`, then update the issue and add an explanatory
  comment when appropriate.
- Do not infer a project, cycle, priority, due date, or assignee.
- Treat Linear's current workflow state as canonical. Do not infer it from
  implementation, Git, pull requests, CI, deployments, or releases.
- Read every affected issue back after a write and verify its state, labels,
  relationships, and comment content.

## CLI 2.3.0 team-label workaround

In `@schpet/linear-cli` 2.3.0, `label list` may omit team-scoped labels. Never
recreate an apparently missing label based on that command alone.

Verify labels through the authenticated GraphQL escape hatch:

```bash
env -u LINEAR_API_KEY .agents/tools/linear/node_modules/.bin/linear \
  --workspace jacobfvanzyl api \
  '{ teams { nodes { key labels { nodes { id name description color team { key } } } } } }'
```

Check both process failure and the response's top-level `errors` field. Select
team `WVE`, distinguishing team labels (`team.key == "WVE"`) from inherited
workspace labels (`team == null`).

## When a skill says "publish to the issue tracker"

Create a Linear issue under team `WVE`, using the pinned CLI and explicit
workspace selection.

## When a skill says "fetch the relevant ticket"

Fetch the supplied `WVE-<number>` issue with `issue view --json`.

## Wayfinding operations

Used by `/wayfinder`. The map is one Linear issue with child issues as tickets.

- **Map:** One issue holding the Notes, Decisions-so-far, and Fog sections.
- **Child:** A sub-issue of the map, created with native `--parent` support.
- **Blocking:** Use Linear's native blocking relationship.
- **Frontier:** List the map's open children, excluding assigned issues and
  issues with unresolved blockers; the first remaining child in map order wins.
- **Claim:** Assign the child to the driving developer as the session's first
  write.
- **Resolve:** Add the result as a comment, transition the child to the
  canonical completed state, and add the context pointer to the map.
