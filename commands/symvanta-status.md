---
description: Symvanta connection and index health snapshot: bound project, indexed repositories, freshness, graph density, and MCP wiring.
argument-hint: "[repository (optional)]"
---

Report the Symvanta connection and index health for this workspace.

$ARGUMENTS

Steps:

1. Call `init` with `repository` set to this checkout's GitHub remote as `owner/name` (from `git config --get remote.origin.url`; omit it when the directory has no remote), unless the command argument names a repository to report on instead.
2. If `workspace.attached` is false, say plainly that this checkout is not attached to a Symvanta project, that the projects `init` lists are other codebases, and that attaching needs `add_repository` (private repositories: `installation_id` from `list_installations`) or `create_project` first, which requires an `mcp:admin` token; then stop. If `init` returns an empty `repositories` list (or `list_repositories` returns none), say no repositories are attached to the active project and stop.
3. For each indexed repository, report name, last indexed time, indexed commit SHA, and the node and edge counts from `list_repositories`. Call `freshness` per repository and flag one whose indexed SHA trails its default branch (a recent push will not be in the graph yet).
4. Flag any repository that `list_repositories` reports with edgeCount 0: `relate` traversal returns empty for it silently, so recommend a reindex. Call `index_health` and report `unindexableRepositories` and `degradedRepositories` (for example `scip_runner_failed` or `community_detection_skipped`, which empties `map` view:"architecture").
5. Report the MCP wiring in OMP terms: the server is named `symvanta` (HTTP transport, default `https://mcp.symvanta.com/mcp`, overridable with `SYMVANTA_MCP_URL`, 120000 ms timeout). If tools are missing or calls fail with an auth error, tell the user to run `/mcp list` to confirm the server came from this extension package, `/mcp test symvanta`, and `/mcp reauth symvanta` to refresh a stale OAuth credential, then `/mcp reload` after changing config.
6. Keep the output to a compact summary the user can scan at a glance.
