---
name: symvanta
description: Route code navigation and impact analysis through the Symvanta graph in OMP instead of searching files by hand. Load when choosing between graph tools and local read/grep/lsp, when a graph lookup comes back empty or the checkout is not indexed, before editing shared code, or when mapping a returned filePath onto the local checkout. Covers session binding, the intent-to-tool matrix, graph-to-local-read workflow, the LSP boundary, the blast-radius gate, uncommitted overlays, diff impact, freshness, feedback, and fallbacks.
---

# Symvanta in OMP

This plugin makes Symvanta the default path for finding code, understanding it, and
sizing a change. The always-apply rule next to this skill is the short version of the
same policy; this file is the detailed reference, load it when a routing decision is
not obvious. Tool names below are the bare Symvanta MCP names (`init`, `relate`,
`estimate_scope`, ...). The host may prefix MCP tools on some transports; match on the
bare name either way.

The plugin also ships user-invoked commands for the common runs: `/symvanta-ask`,
`/symvanta-blast`, `/symvanta-trace`, `/symvanta-status`, `/symvanta-architecture`,
`/symvanta-scope`, `/symvanta-tests`, `/symvanta-working-tree`, `/symvanta-route`,
`/symvanta-branch`, `/symvanta-recent`, and `/symvanta-clear`. They expand into the
same tool calls described here, so reaching for one is never a detour. The last four
cover the route, branch-pin, history, and unpin workflows in the matrix below.

## What the plugin wires up

- MCP server `symvanta`, HTTP transport, default `https://mcp.symvanta.com/mcp`,
  overridable through the `SYMVANTA_MCP_URL` environment variable, request timeout
  120000 ms. It is declared in the plugin's own `.mcp.json`, so no manual server entry
  is needed.

When the server itself misbehaves, inspect it with the host's own commands rather than
guessing: `/mcp list` shows which config file the `symvanta` entry came from,
`/mcp test symvanta` probes connectivity, `/mcp reauth symvanta` refreshes a stale
OAuth credential, and `/mcp reload` rediscovers after a config or env change. A call
that hangs is usually an unauthenticated remote server, not a slow graph.

## OMP hook behavior

Two behaviors belong to the extension itself, not to any tool call you make:

- **Session start.** One hidden, agent-attributed custom message (`customType:
  symvanta.repository`) is queued for the next turn. It names the checkout's
  `owner/name` slug and says to bind with `init`; with no git remote it says the tree
  cannot be indexed, and outside a checkout it says to call `init` without a
  repository. The server field it refers to is `workspace.attached`.
- **First write.** A `tool_call` guard on `edit`, `write`, and `apply_patch` blocks once
  per session when the target is an existing code file and no impact check has run.
  It is fail-open: if no `relate` / `estimate_scope` definition is loaded, or any
  internal error occurs, the write proceeds. A successful `relate` (kind:blast_radius)
  or `estimate_scope` disarms it for the rest of the session, and one block disarms it
  too, so a session can never stall. `SYMVANTA_IMPACT_MODE=off` turns it off. The
  block reason names the raw tool calls, and because slash commands are not
  model-callable it points the user at `/symvanta-blast`. New files and non-code files
  are never gated.

Details of the same rule, plus when to run the check on your own initiative, are under
"Impact gate before editing or sizing".

## Bind the session before querying

Call `init` once at the start of any session that will touch code:

- With a local git remote, pass `repository: "owner/name"` (a full clone URL is also
  accepted) taken from `git config --get remote.origin.url`. This binds the session to
  the project that holds the checkout and pins it, so later calls resolve there without
  repeating `projectId`.
- `workspace.attached: false` means this checkout is not indexed. Nothing in that
  response describes it. Do not query the graph for this tree and do not treat the
  projects `init` lists as candidates, they are other codebases. Attach with
  `add_repository` (`installation_id` from `list_installations` for a private
  repository), creating a project first with `create_project` when it needs its own.
  Those three calls need an `mcp:admin` token; a first-party connection token has it,
  a read-only token gets `admin_scope_required` and the user has to attach it from the
  dashboard.
- No remote, or not a checkout: call `init` without `repository`. The active project is
  the pinned one or the workspace default, and `project_source` says which.
- An attached project whose `init` response has an empty `repositories` list (or whose
  `list_repositories` returns none) has nothing to query yet. Tell the user that
  plainly and do not silently substitute shell search over unrelated files.
- A tenant can hold several projects. Unscoped calls fan out across them and mark
  results with `matchedProject` / per-row `alsoInProjects`. For `locate` that fan-out is
  budget-asymmetric: the active project gets the full budget, the rest get a small
  bounded one, so a non-default project can return partial results. Pass `repository`
  or `projectId` when you know where to look.
- Routing tools may attach `next_steps: [{ tool, reason }]` on empty or partial
  results. Follow them; they encode the intended order (graph, then text, then local
  grep).

## Path convention

Every `filePath` in a Symvanta response is repo-relative logical (`src/user/email.ts`),
never `<repo>/src/user/email.ts`. Map it onto the local layout before reading, and pass
the logical form back when a tool asks for a `filePath`. On a multi-repo project, the
`source` tool accepts a `<RepoName>/` prefix to pick the repository and skip its
`repository` argument. When a graph result and a live file disagree, the live file is
right: say so and check `freshness` before relying further on the index.

## Intent to tool

| Intent | Call |
|---|---|
| First pass over an unfamiliar task or area | `context` |
| Behavior question ("how does X work", "why", "what triggers") | `ask_codebase` |
| Same, spanning repositories | `ask_codebase` (`scope: "all"`) |
| Look up a known symbol, or resolve one of several matches | `find_node` |
| Search symbols by name or pattern | `locate` (mode:symbol) |
| Find a file by name fragment | `locate` (mode:file) |
| Literal identifier or string, several at once | `locate` (mode:text, `queries: [...]`) |
| Fuzzy or conceptual match | `locate` (mode:semantic) |
| Unsure which mode | `locate` with no mode (text, then semantic) |
| Cross-repo candidate scan | `locate` (mode:codebase) |
| HTTP route by path, optionally by method | `find_http_route` |
| Who calls X | `relate` (kind:callers) |
| What breaks if X changes | `relate` (kind:blast_radius) |
| What X depends on | `relate` (kind:dependencies) |
| What implements interface I | `relate` (kind:implementers) |
| Type hierarchy | `relate` (kind:heritage) |
| Full call chain, or runtime order through a class | `relate` (kind:chain, `staysWithinClass`) |
| How X and Y connect | `relate` (kind:path, `selectors: [from, to]`) |
| Orient on a repo or subtree | `map` (`view: "architecture"` for modules) |
| Symbols in one file | `list_file_symbols` |
| Config key or environment variable usage | `locate` (mode:config) |
| Existing tests for a symbol | `list_tests_for` |
| Estimated size of a change | `estimate_scope` |
| What a diff or branch breaks | `diff_impact` |
| Uncommitted edits as queryable state | `ref` (op:index_working_tree) |
| Pin reads to a tracked branch | `ref` (op:use, then `clear`) |
| Drop a revision pin, or unbind the project | `ref` (op:clear, op:clear_project) |
| Record or read a decision | `adr` (op:record or list) |
| Raw file, tree, blame, or diff with no local clone | `source` |
| Commit history / recently changed, optionally by path | `history` (op:commits, op:recently_changed) |
| Library package or version facts | `library` |
| Fast definition-only lookup of a name | `quick_lookup` |
| Several independent lookups in one round-trip | `bundle` (locate, relate callers, find_node, list_file_symbols, find_http_route) |
| Bind the session | `init` |
| Index health, degradation, modularity Q | `index_health` |
| Reindex after a push (needs mcp:admin) | `reindex_repository` |
| Attach or create | `add_repository`, `create_project`, `list_installations` |

`find_node` and the `relate` kinds take 1 to 10 selectors, so pass several symbols in
one call instead of looping. `context` is the one-call orientation when you do not yet
have a symbol name: it replaces chaining `locate` (text) plus `locate` (semantic) plus
`list_file_symbols`.

## Graph first, local read second

On an attached, indexed repository, the graph answers first: `context`, `locate`, or
`find_node` before `grep`, `glob`, or shell `grep`/`rg`. Local search is a fallback, not
a first move.

The graph finds, the local read views. Once a result gives you `filePath` plus line
bounds, read exactly that range (`read` with `offset` / `limit`) instead of the whole
file. Use `read` rather than the `source` tool whenever a clone exists; `source` is for
cloud or no-clone sessions.

Do not use `grep` / `glob` to reconstruct structure an indexed repo can answer: `context`
orients on a whole task in one call, `locate` (mode:text) with `queries: [...]` replaces a
multi-pattern grep, and `list_file_symbols` replaces a file outline pass. A local checkout
does not license hand-tracing who-calls, what-depends, or what-breaks; those stay `relate`
queries. Local commands are for local facts (working tree state through `bash` `git
status`, layout through `glob`), not for discovering code.

Local search is a legitimate first move only when the checkout is unattached, the
repository is unindexed (`init` returns an empty `repositories` list for the bound
project, `repository_not_indexed`, or `list_repositories` reports nodeCount or edgeCount 0),
or `freshness` shows the index stale for the file you need. Otherwise walk the
graph-to-text chain: `locate` (mode:text), then `locate` with no mode, then local `grep`.
A local `grep` that returns nothing is not evidence of absence: call `locate` with no
mode (text, then semantic) before concluding a symbol or string is missing.

About to open a third file to hand-trace a flow? Stop and call `ask_codebase` instead.

## LSP boundary

`lsp` and Symvanta answer different questions, and the wrong one wastes a turn:

- Use `lsp` for exact, compiler-resolved facts inside this checkout: references,
  definition, type definition, implementation, hover, diagnostics, and every rename or
  refactor. Renames go through `lsp` (rename) so call sites, re-exports, and shadowing
  are followed; never rename with text edits.
- Use Symvanta for cross-file and cross-repository blast radius, framework and DI edges
  the compiler cannot see, module architecture, commit or diff level impact, the library
  catalog, and anything covering repositories other than this checkout.
- Locate with the graph, resolve with the language server. When a rename or a refactor
  needs exact reference sets, `lsp` is authoritative; when you need "what else in the
  monorepo or in a sibling service depends on this", Symvanta is.
- Each `relate` row may carry an edge `confidence` tier: `high` is compiler-grade
  (SCIP), `medium` is framework or heuristic, `low` is string-heuristic,
  `correlational` is git co-change. Treat `low` and `correlational` as leads to verify
  with `lsp` or a live read, not as a caller list.
- Confidence on the node is separate from confidence on the edge: `find_node` can return
  a high-confidence wrong kind (a property instead of the class). Check `node.kind`.

## Impact gate before editing or sizing

The same obligation applies to your own judgment whenever you size a change, not only
when you edit one, and the plugin's `tool_call` hook enforces it for the first write
(mechanics in "OMP hook behavior" above). Compare two implementations with
`list_file_symbols` on both files instead of reading both in full. Run `estimate_scope`
as the pre-flight for multi-file work, and read any `decisions` that `find_node`
attaches: a recorded ADR may forbid the change, in which case supersede it with `adr`
(op:update) rather than working around it.

Stop and confirm scope with the user when the blast radius spans roughly more than five
files, crosses architectural layers, or has cross-repo edges (`wide_blast_radius`
true). Skip the check when the symbol was just created, when the task names every file
to touch, or when the change is ABI-compatible such as adding a parameter with a
default.

## Uncommitted edits

The index lags the working tree, so uncommitted work is invisible until you overlay it:

1. `ref` with `op: "index_working_tree"`, `changedFiles: [{ path, content }]` for edits
   and `deletedPaths: [...]` for removals. Send real current content, not diffs.
2. Symvanta seeds a checkout at the base revision, overlays the payload, indexes a
   synthetic ephemeral revision, and auto-pins the session to it.
3. `freshness` echoes the pinned synthetic SHA, which is how you confirm the overlay
   took effect.
4. Limits: the `source` tool and `locate` (mode:semantic) do not reflect the overlay
   because it is not a real commit. Graph, text, and symbol tools do.
5. `ref` with `op: "clear"` unpins when the overlay is no longer wanted.

Keep the payload small: skip binaries and very large files, and do not "overlay
everything" when a handful of files changed.

## Diff impact

One `diff_impact` call replaces a per-symbol loop after a multi-file change or before a
merge: it unions the blast radius of the changed files and reports affected endpoints,
test suites, and co-change reminders. With an overlay already pinned, call it with no
SHAs so it diffs against the synthetic revision; otherwise pass the base and head SHAs
you care about. It also composes with `ref` (op:use) to answer "what does this branch
break before it merges?"

## Freshness

`freshness` reports `lastIndexedSha`, `lastIndexedAt`, and the remote HEAD it can see.
With a local clone, compare `git rev-parse HEAD` against `lastIndexedSha`:

- Equal: do not pass `commitSha`, the index and the checkout agree.
- Local ahead (index stale): for reproducible review work pass `commitSha:
  <lastIndexedSha>`; otherwise proceed and note that the graph describes pre-push
  reality.
- Local behind: pass `commitSha: <localHEAD>` so results match the files you will read.
  Only revisions still in the retention window resolve, and an old one returns
  `revision_not_indexed` instead of quietly answering from a different revision.

Cloud sessions and no-clone checkouts skip this comparison and query the latest indexed
revision. Every MCP answer describes the indexed revision, not your unsaved buffer: after
a change, verify against the live file with `read`, and treat `find_node` resolving the
symbol plus `relate` (kind:callers) showing no new unintended caller as the post-edit
check. For a multi-file change, `diff_impact` covers that in one call. Record a
non-obvious decision with `adr` (op:record) using the symbol path from `find_node`.

## Feedback

Each `ask_codebase` answer carries an `answer_id`. On any later Symvanta call, report
the outcome with `feedback: { answerId, outcome }`, where the outcome is `useful` (it
led to the right code), `dead_end` (it led nowhere), or `corrected` (the user corrected
it, with the corrected fact in `correction`). Only report `corrected` when the user
actually corrected the answer, not when you changed the code yourself. One report per
answer is enough, and the signal sharpens the next answer for everyone on the project.
Node results can also carry `lessons` hints; a stale marker means the cited code moved
since the answer was recorded, so re-verify against the live file before relying on it.

## Fallbacks

- Not attached, not indexed, or the bound project lists no repositories: work with
  local `read`, `grep`, `glob`, and `lsp`, and label answers that came from local files
  rather than the graph. Cross-repo signals are simply unavailable in that state.
- `repository_not_indexed` with a local clone: fall back to local tools for this
  repository and say that callers and the library catalog are missing.
- `list_repositories` reports edgeCount 0 (or nodeCount 0) for a repository: `relate`
  returns empty for it with no error. Use `locate` (mode:text) and then local `grep`, and
  tell the user a reindex is needed.
- An empty `relate` result is not proof that the index is stale. Move along the chain:
  graph tool, then `locate` (mode:text), then local `grep`.
- `locate` (mode:text) returning empty does not improve by rewording it. Call `locate`
  (mode:semantic) with the same query, or `locate` with no mode.
- A local `grep` that returns nothing is not evidence of absence either. Call `locate`
  with no mode (text, then semantic) before concluding a symbol or string does not exist.
- Prefer clarity over silent fallback: when you answer from local files because the
  graph could not, say which tool failed and why.

Recognize these envelopes and act locally instead of retrying blindly:
`private_repository_needs_credential` and `installation_lacks_repository` (call
`list_installations`, or have the user grant access), `admin_scope_required` (the user
must act in the dashboard), `plan_limit_exceeded` (plan caps, tell the user),
`repository_not_attached` (check spelling, then `list_repositories`), `file_not_found`
(the file may be renamed on a newer commit; check `freshness`), `out_of_bounds` (shrink
the line range), `file_too_large` (retry with `startLine` and `endLine`),
`stale_index` (proceed on the indexed revision and say so), and `revision_not_servable`
(drop `commitSha`; the named revision's graph was superseded, so discard architecture
numbers read at it, except for a revision flagged `architectureSnapshot: true`).

## Delegating

A `task` subagent starts blank: it does not receive this session's startup context, so a
generic subagent defaults to `grep` and `glob`. When you delegate search or
understanding, put the routing in the assignment: bind with `init` first, use the bare
Symvanta tools for finding and impact questions, and read only what the graph located.
Use the read-only `scout` agent for exploration and keep the graph-first instruction in
its prompt; hand its findings to a writing agent rather than re-deriving them yourself.
