---
name: symvanta
description: Route code navigation, impact analysis, and index-freshness checks through the Symvanta code graph, and keep text search and LSP for what the graph cannot answer.
alwaysApply: true
---

# Symvanta routing

The `symvanta` MCP server is this project's default navigation and impact-analysis path. Bind it once per session, then answer code questions from the graph before reaching for search or the filesystem.

## Binding

1. Call `init` once at the start of a session. In a GitHub checkout, pass the checkout's remote as `repository` ("owner/name"); the plugin's startup context supplies the slug. init reports the active project and `workspace.attached`.
2. `workspace.attached=false` means this checkout is not indexed: nothing init reports describes it. Do not route through the other projects it lists. Work with local tools (`read`, `grep`, `lsp`) and offer to attach the repository (add_repository; a private repository needs installation_id from list_installations).
3. Bound once, later calls resolve in that project without repeating projectId.

## Decision matrix

| Question | Use |
| --- | --- |
| First pass over an unfamiliar task or area | `context` (natural-language task, ranked files) |
| How does X work, where is the flow | `ask_codebase` (scope "all" for cross-repo) |
| Definition, signature, exact location | `find_node` |
| Who calls X, what X depends on | `relate` (kind: callers, dependencies) |
| What breaks if X changes | `relate` (kind: blast_radius) |
| Implementers of an interface, type hierarchy | `relate` (kind: implementers, heritage) |
| Literal identifier, string, or config key | `locate` (mode: text, or config for env vars) |
| HTTP route by path and method | `find_http_route` |
| Repo or subtree skeleton | `map` |
| Symbols in one file | `list_file_symbols` |
| What a diff or branch breaks | `diff_impact` |
| Fuzzy "is there anything like this" | `locate` (mode: semantic) |

An empty `locate` (mode: text) is not evidence of absence: the same tool auto-routes to semantic when called with no mode, so retry that way instead of rewording the query.

## Graph before local search

On an attached, indexed repository (`workspace.attached` true; `list_repositories` reports a non-zero edgeCount), the graph answers first: `locate`, `find_node`, or `context` before `grep`, `glob`, or shell `grep`/`rg`. Local search is a fallback, not a first move.

- Walk the graph-to-text chain before falling back: `locate` (mode: text), then `locate` with no mode, then local `grep`. A local `grep` that returns nothing proves nothing: call `locate` with no mode (text, then semantic) before concluding a symbol or string is absent.
- Local search is a legitimate first move only when the checkout is unattached, the repository is unindexed (`init` returns an empty `repositories` list for the bound project, `repository_not_indexed`, or `list_repositories` reports nodeCount or edgeCount 0), or `freshness` shows the index stale for the file you need.
- A local checkout never licenses hand-tracing callers or blast radius; those stay `relate` queries.

## Graph, then read and edit

- The graph returns paths and line bounds, not source. Open the file with `read` only after the graph names it, and read the range it points at.
- For exact references, renames, and refactors, use `lsp` (references, rename, code actions). Those are compiler-accurate; regex renames silently miss callsites.
- Before editing an existing code file, run the pre-edit impact check: `relate` with kind `blast_radius` for the symbol you are changing, or `estimate_scope` for a task-level estimate. The plugin's impact guard watches `edit`, `write`, and `apply_patch`: it refuses the first write to an existing code file in a session until one of those has run, then fails open, so one refusal disarms it for the rest of the session. SYMVANTA_ENFORCE_IMPACT=off disables it.
- Blast-radius threshold: always check before touching an exported or public symbol, anything with 3 or more callers, anything crossing a module or layer boundary, a route handler, or a shared type. A private helper with only a couple of local callers can go straight to the edit.
- A change that removes, renames, or re-signatures a definition is never local: check `relate` (kind: callers) and update every callsite in the same pass.

## Freshness

- After a push, a rebase, or a branch switch, call `freshness` (init also reports index health) before trusting the graph. A `lastIndexedSha` behind local HEAD means the index is stale: verify each graph answer against the live file, and reindex with `reindex_repository` when a file the graph named no longer exists.
- A repository that `list_repositories` reports with edgeCount 0 has no traversable edges: `relate` answers come back empty there, so fall back to text search inside that repository only.
- Never read an empty `relate` result as proof that nothing depends on the symbol until freshness says the index is current.

## Feedback

- Every `ask_codebase` answer carries an `answer_id`. Report the outcome on any later Symvanta call as `feedback: { answerId, outcome }`, with outcome "useful", "dead_end", or "corrected".
- Read the `lesson` and `lessons` hints on `find_node`, `context`, and citations: they mark known-good and contested anchors.
- When the graph is wrong about this checkout, say so through feedback and correct yourself from the live file, do not silently work around it.
