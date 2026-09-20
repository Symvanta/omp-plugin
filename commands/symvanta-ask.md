---
description: Answer a behavior question ("how does X work", "why does Y happen", "what triggers Z") from the Symvanta graph, with file citations.
argument-hint: "[question]"
---

Answer this behavior question with the Symvanta code graph. Do not reconstruct the answer by opening or grepping files by hand:

$ARGUMENTS

Steps:

1. If this session is not bound to Symvanta yet, call `init` once with `repository: "owner/name"` taken from this checkout's GitHub remote (`git config --get remote.origin.url`; a full clone URL is accepted). If `workspace.attached` is false, stop and say: this checkout is not indexed, and it can be attached over MCP with `add_repository` (private repositories: `installation_id` from `list_installations`) or by creating a project first with `create_project`; meanwhile answer from local files and label the answer as such.
2. Call `ask_codebase` with the question above. Use `scope: "all"` when the question clearly spans repositories or `init` shows sibling repositories in the same project.
3. Present the synthesized answer, then the citations as `filePath:startLine` references. Open one with `read` only when you need verbatim source to quote or to act on.
4. If the answer returns `sufficient_to_answer: false`, follow `notice.gaps` for ONE targeted follow-up (`find_node`, `relate` kind:callers, or `find_http_route`) and then answer. Graph tools first, then `locate` (mode:text), and only then local `grep`: never jump straight from an empty graph result to grep.
