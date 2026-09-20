---
description: Trace a function or symbol with the Symvanta graph: full call chain, direct callers, and dependencies, instead of reading files one by one.
argument-hint: "[symbol]"
---

Trace the execution path of:

$ARGUMENTS

Steps:

1. If the name is ambiguous, resolve it with `find_node` and confirm `node.kind` matches what the user means.
2. Call `relate` (kind:chain) to map the path through the symbol. When only the direct neighborhood matters, use `relate` (kind:callers) for who calls it and `relate` (kind:dependencies) for what it calls; for "how are X and Y connected" use `relate` (kind:path) with `selectors: [from, to]`.
3. Present the chain as an ordered list of `filePath:line` steps, each with a one-line note on its role. Do not open the files to rebuild a chain the graph already resolved. Open one with `read` only to quote or to edit a specific step, and use `lsp` (references, definition) when the user needs exact, compiler-resolved reference lists rather than graph edges.
4. If the symbol belongs to a repo that `list_repositories` reports with edgeCount 0, say so and tell the user it needs a reindex; fall back to `locate` (mode:text) and then local `grep` rather than presenting an empty chain as fact.
