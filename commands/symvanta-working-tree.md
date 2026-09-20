---
description: Overlay uncommitted working-tree edits onto a synthetic indexed revision so graph, text, and symbol tools reflect unpushed changes.
argument-hint: "[repository (optional)]"
---

Overlay the uncommitted edits of this checkout so Symvanta's graph reflects them:

$ARGUMENTS

Steps:

1. List the changes with `bash`: `git status --porcelain` and `git diff --name-only` give the modified and added paths plus deletions. If the tree is clean, say so and stop.
2. `read` each changed file's current content. Skip binaries and very large files and keep the set small so the payload stays manageable.
3. Call `ref` with `op: "index_working_tree"`, passing `changedFiles: [{ path, content }, ...]` for the edits and `deletedPaths: [...]` for removals, plus `repository` when the argument names one. Symvanta seeds a checkout at the base revision, overlays these, indexes a synthetic ephemeral revision, and pins this session to it automatically.
4. Confirm the pin with `freshness` (it echoes the synthetic SHA). State the limits: the `source` tool and `locate` (mode:semantic) do not reflect the overlay because it is not a real commit, while graph, text, and symbol tools do.
5. With the overlay pinned, offer `diff_impact` with no SHAs: it unions the blast radius of the uncommitted work and lists affected tests, endpoints, and co-change reminders. Run `ref` with `op: "clear"` when the overlay is no longer wanted, since it holds reads on the synthetic revision.
