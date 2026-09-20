---
description: Find the existing tests that cover a symbol, from the graph rather than by guessing at test file names.
argument-hint: "[symbol]"
---

Find the tests that cover:

$ARGUMENTS

Steps:

1. If the symbol name is ambiguous, resolve it with `find_node` and confirm `node.kind` matches what the user means.
2. Call `list_tests_for` on the resolved symbol: it matches test suites and cases whose suite name contains the symbol name. When you need the cases themselves rather than their suites, call `locate` with `mode: "symbol"`, `kind: "test_case"`, `includeTests: true`, and the relevant symbol or suite name.
3. Report each match as a `filePath:line` reference with its test name. If nothing comes back, say so plainly: the symbol may be untested, or its tests may live in a path the index does not cover.
4. Offer to open a match with `read`, to run the suite through the project's own test command, or to trace the symbol with `/symvanta-trace`.
