---
description: Drop the Symvanta session pin: the branch or working-tree revision pin by default, and the project binding only when explicitly asked.
argument-hint: "[branch | working-tree | project (optional)]"
---

Clear the Symvanta session pin named above, or the revision pin when none is named:

$ARGUMENTS

Steps:

1. Two different bindings exist here, and only one is implied by default:
   - the revision pin written by `ref` with `op: "use"` (a branch) or `op: "index_working_tree"` (the synthetic overlay), which holds this session's reads on that revision;
   - the project binding written by `init` or `ref` with `op: "use_project"`.
   Name which one is about to be dropped before dropping it.
2. Default, meaning no argument or an argument naming the branch or the working tree: call `ref` with `op: "clear"`. That reverts reads to the default branch and discards a working-tree overlay pin. Confirm with `freshness` that the default branch is served again, and say the pin is gone.
3. Only when the argument explicitly names the project, call `ref` with `op: "clear_project"`. That drops the project binding, so later unscoped calls fall back to the workspace default project and may resolve to a different codebase. Say that, and note that `init` with a repository slug binds it again.
4. Never call `clear_project` as a side effect of clearing a revision pin, and never treat the two as interchangeable: a user who pinned a branch for a review does not expect their project binding to move. When the request is ambiguous, clear the revision pin and ask before moving the project binding.
5. Nothing pinned: `ref` with `op: "clear"` is harmless, but say plainly that there was no pin instead of implying one was removed.
6. This command changes only which revision and project this session's reads resolve to. The working tree itself, the index, and the pre-edit impact gate are untouched.
