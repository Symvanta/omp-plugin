---
description: High-level architecture of the indexed codebase: functional modules, their PageRank hubs, cross-module coupling, and the load-bearing functions.
argument-hint: "[repository (optional)]"
---

Show the module-level architecture of this codebase, not the file tree.

$ARGUMENTS

Steps:

1. Call `map` with `view: "architecture"`. Pass `repository` when the argument names one. Otherwise call `init` first and use `workspace.repository` when this checkout is attached. If the active project has several repositories and there is no attached checkout, ask which repository to map.
2. Report the detected modules: for each, its name, size, and PageRank hub, which is the module member other modules depend on most. Call out the notable cross-module couplings so the reader sees how modules lean on each other.
3. Surface the repo-wide load-bearing functions from the top of the map: the functions the whole codebase leans on most by PageRank. This is the onboarding "start here" list.
4. Call `index_health` to add the modularity Q (how cleanly the modules separate; a low Q flags a tangled codebase). If the map came back with no modules, check `degradedRepositories` for `community_detection_skipped` before reporting a flat architecture.
5. Offer a drill-down: `map` scoped to a `path`, `list_file_symbols` for one module member, or `/symvanta-trace` on a hub to follow its call chain.
