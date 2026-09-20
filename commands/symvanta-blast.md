---
description: Blast-radius check before editing a symbol. Shows what breaks across files, layers, and repositories, and satisfies the plugin's pre-edit impact gate.
argument-hint: "[symbol or path:symbol]"
---

Assess the blast radius of this symbol before any edit:

$ARGUMENTS

Steps:

1. If the name is ambiguous, resolve it with `find_node` first and confirm `node.kind` matches what the user means (a class versus a same-named property, an interface versus one implementation). If `find_node` returns `resolved: false`, pick from `candidates` or ask which one; do not act on a low-confidence guess.
2. Call `relate` (kind:blast_radius) on the resolved symbol with `includeCrossRepo: true`, and read back any `decisions` the node carries: a recorded ADR may forbid or constrain the change.
3. Summarize: files affected, whether the blast crosses architectural layers, and any cross-repo edges (each cross-repo row names its `repositoryName`). Treat `low` and `correlational` edge confidence as leads to verify, not as verified callers.
4. End with a one-line verdict:
   - SAFE: isolated, few callers in one layer.
   - CAUTION: `wide_blast_radius` is true, more than about 5 files, or any cross-repo edge. Name the risky callers and confirm scope with the user before editing.
5. State that this call disarms the plugin's impact gate for the rest of the session. The gate watches `edit`, `write`, and `apply_patch`, refuses the first write to an existing code file in a session, and fails open after that one refusal, so no further pre-edit check is needed for the symbols just covered.
