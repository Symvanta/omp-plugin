---
description: Recent indexed history: the files changing most often, and the latest commits, optionally scoped to one path.
argument-hint: "[path (optional)]"
---

Report recent history from the Symvanta index:

$ARGUMENTS

Steps:

1. Bind the session first when it is unbound: `init` with this checkout's GitHub remote. Pass `repository` (as `owner/name`) when the argument names one or the active project holds several.
2. Call `history` with `op: "recently_changed"` for the files changing most often, which is the "where is work happening" view. With a path argument, also call `op: "commits"` with `path` set to that repo-relative path to list the commits touching it, so the answer covers both the hot files and one area's own history.
3. Pass `since`, `until`, `author`, or `limit` when the request names a time window, a person, or a row count; otherwise leave the defaults and report that the window is the index's own.
4. Report a scannable summary: the top handful of files with their change counts, then the recent commit subjects with short sha and date. Do not dump every row unless the user asks for more.
5. State the limit plainly: this is the indexed window, not all of git history. With a local clone, `git log` sees farther back, so say that and use it when the user needs older history; use `history` (`op: "commit"`, `sha`) when they need one commit's diff summary.
6. If the result looks stale (an old `lastIndexedAt`, or nothing from a change the user just pushed), say so and point at `/symvanta-status` to check the index, since a reindex needs `mcp:admin`.
7. Offer the next step on a hot symbol: `find_node` to resolve it, then `/symvanta-blast` or `/symvanta-trace`. For a path with uncommitted work, `/symvanta-working-tree` is the better view.
