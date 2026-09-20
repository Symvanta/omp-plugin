---
description: Pin this session's graph reads to a tracked branch, or drop the pin, so results describe that branch instead of the default branch.
argument-hint: "[branch name, or clear (optional)]"
---

Pin this session's Symvanta reads to:

$ARGUMENTS

Steps:

1. Bind the session first when it is unbound: `init` with `repository: "owner/name"` taken from `git config --get remote.origin.url`. A branch pin belongs to one repository, so pass `repository` too when the active project holds several and it is not the attached one.
2. With a branch name, call `ref` with `op: "use"` and `branch` set to it. State the precondition plainly: the branch must already be tracked and indexed for this repository, which means an open pull request against it or the branch added on the dashboard. A branch that is only local, or tracked but still indexing, fails with `indexing_in_progress` and nothing is pinned.
3. Confirm with `freshness`, which echoes the revision now being served, and say which branch the session reads and that graph, text, and symbol tools all follow it.
4. With no argument, do not guess a branch. Report the current pin state from `freshness`, then ask which tracked branch to pin, or tell the user to rerun this command with `clear` to drop it.
5. With `clear`, call `ref` with `op: "clear"` to revert reads to the default branch and say so. That op drops a branch or working-tree pin only and never moves the project binding; when the user actually wants to unbind the project, tell them to use `/symvanta-clear project` instead.
6. Keep a pin only while it is useful. While one is set, every read describes that branch rather than the default, which is a real risk of answering from the wrong revision once the work moves on, so offer `clear` when the review is over.
