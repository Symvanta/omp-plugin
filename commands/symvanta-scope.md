---
description: Pre-flight scope estimate for a change before sizing or planning it, grounded in the graph instead of a guess at call sites.
argument-hint: "[symbol or change description]"
---

Estimate the scope of this change before sizing it:

$ARGUMENTS

Steps:

1. If a symbol is named and the name is ambiguous, resolve it with `find_node` first.
2. Call `estimate_scope` for the change. This is the pre-flight for multi-file work: do not eyeball call sites and guess.
3. Report the estimated blast: files touched, architectural layers spanned, whether it crosses repositories, and a rough size (small, medium, large). Note the repository IDs it returns are numeric, while `init` and `freshness` use base62; both are opaque, so pass each back to the tool that produced it.
4. End with a one-line read: a contained edit, or one that needs a plan and scope sign-off with the user first. For a per-symbol "what breaks if I change X" view, use `/symvanta-blast`.
