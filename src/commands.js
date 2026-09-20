/**
 * Extension command templates for the Symvanta OMP plugin.
 *
 * OMP exposes two kinds of slash command, and only one of them keeps its name:
 * a markdown file under `commands/` is a plugin file command, which a
 * marketplace install hands to OMP's namespace rewriting, so a documented
 * `/symvanta-blast` would be reachable only as `/symvanta:symvanta-blast`. A
 * command registered by the extension keeps the name it was registered with, in
 * every install shape. This module is what lets the extension register the
 * documented twelve from the same markdown the file commands use, so the
 * instruction text has one source and the names have two.
 *
 * The extension reads each template lazily, on the first invocation, and falls
 * back to a short built-in body when the file is missing. That keeps load-time
 * registration free of I/O and keeps a partially copied plugin working.
 *
 * `$ARGUMENTS` (and `$@`, which OMP treats as the same aggregate) is replaced
 * with what the user typed; `$@[n]` slices are left alone. A template that
 * carries no placeholder gets the argument appended, which is what OMP's own
 * file-command expansion does.
 *
 * Only `node:fs` and `node:path` are imported here: a template is a local file
 * in the plugin, and nothing in this module opens a socket or reads a
 * credential.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The twelve extension commands, in registration order. `description` is what
 * OMP lists for the command and mirrors the `description` in the matching
 * `commands/<name>.md` frontmatter; `fallback` is the body used when that file
 * cannot be read. Both are here so registration needs no disk access.
 */
export const SYMVANTA_COMMANDS = Object.freeze({
  "symvanta-ask": {
    description: 'Answer a behavior question ("how does X work", "why does Y happen", "what triggers Z") from the Symvanta graph, with file citations.',
    fallback: "Answer this behavior question from the Symvanta graph, not from a tree scan:\n\n$ARGUMENTS\n\nCall `ask_codebase` (scope:\"all\" when the answer spans repositories), then report the answer with the citations it returned and treat those as authoritative. Do not reconstruct the answer by hand when `ask_codebase` already answered it.",
  },
  "symvanta-blast": {
    description: "Blast-radius check before editing a symbol. Shows what breaks across files, layers, and repositories, and satisfies the plugin's pre-edit impact gate.",
    fallback: 'Assess the blast radius of this symbol before any edit:\n\n$ARGUMENTS\n\nResolve the name with `find_node` when it is ambiguous, then call `relate` (kind:blast_radius) with `includeCrossRepo: true`. Report the affected files, whether the blast crosses a layer, and any cross-repo edges; treat low and correlational confidence as leads to verify. Confirm scope with the user before editing a wide blast radius. This call disarms the plugin impact gate for the session.',
  },
  "symvanta-trace": {
    description: "Trace a function or symbol with the Symvanta graph: full call chain, direct callers, and dependencies, instead of reading files one by one.",
    fallback: "Trace this symbol with the Symvanta graph:\n\n$ARGUMENTS\n\nResolve it with `find_node`, then call `relate` (kind:chain) and report each hop with its filePath and line bounds. Add `staysWithinClass: true` for a class-local trace, `kind:callers` for the direct callers, and `kind:dependencies` for what it depends on. Open a file with `read` only to quote it.",
  },
  "symvanta-status": {
    description: "Symvanta connection and index health snapshot: bound project, indexed repositories, freshness, graph density, and MCP wiring.",
    fallback: 'Report the Symvanta connection and index health for this workspace:\n\n$ARGUMENTS\n\nCall `init` with this checkout\'s GitHub remote as `owner/name` (omit it when the directory has no remote). Report `workspace.attached`; when it is false, say this checkout is not attached to a Symvanta project and stop. Otherwise call `freshness` per repository and flag one whose indexed sha trails its default branch, then call `index_health` and report `unindexableRepositories` and `degradedRepositories`. Keep the summary compact.',
  },
  "symvanta-architecture": {
    description: "High-level architecture of the indexed codebase: functional modules, their PageRank hubs, cross-module coupling, and the load-bearing functions.",
    fallback: "Show the module-level architecture of this codebase:\n\n$ARGUMENTS\n\nCall `map` with view \"architecture\" and report the functional modules, their hubs, and the cross-module coupling, plus the repo-wide load-bearing functions line. Add `index_health` for the modularity figure (a low Q flags a tangled codebase). Offer to drill into one module with `find_node` or `/symvanta-trace`.",
  },
  "symvanta-scope": {
    description: "Pre-flight scope estimate for a change before sizing or planning it, grounded in the graph instead of a guess at call sites.",
    fallback: "Estimate the scope of this change before planning it:\n\n$ARGUMENTS\n\nCall `estimate_scope` for the task-level file and layer count, and `locate` (mode:semantic) when the description is fuzzy rather than precise. Report how many files and layers it likely touches and whether it spans repositories, then say plainly that this is an estimate from the index, not a verified callsite list.",
  },
  "symvanta-tests": {
    description: "Find the existing tests that cover a symbol, from the graph rather than by guessing at test file names.",
    fallback: "Find the tests that cover this symbol:\n\n$ARGUMENTS\n\nResolve the name with `find_node`, then call `list_tests_for` on it and report every suite and case returned. If the list is empty, say so rather than inferring coverage from a test file's name, and suggest `/symvanta-blast` to see what else the symbol touches.",
  },
  "symvanta-working-tree": {
    description: "Overlay uncommitted working-tree edits onto a synthetic indexed revision so graph, text, and symbol tools reflect unpushed changes.",
    fallback: 'Make the uncommitted edits queryable:\n\n$ARGUMENTS\n\nCollect the changed paths, then call `ref` with `op: "index_working_tree"`, `changedFiles: [{ path, content }]`, and `deletedPaths` for removals. Confirm the pinned synthetic sha with `freshness`. State the limits: `source` and `locate` (mode:semantic) do not reflect the overlay, and `ref` with `op: "clear"` unpins it.',
  },
  "symvanta-route": {
    description: "Resolve an HTTP route to the handler and middleware that serve it, from framework router metadata instead of a grep for the URL string.",
    fallback: "Resolve this HTTP route to the code that serves it:\n\n$ARGUMENTS\n\nCall `find_http_route` with the path, adding `method` only when one is named. Report each match as `METHOD path -> filePath:startLine`, naming the handler and any middleware attached on the way in. When nothing matches, say so and retry with a broader partial path; open the file only to quote or edit the handler.",
  },
  "symvanta-branch": {
    description: "Pin this session's graph reads to a tracked branch, or drop the pin, so results describe that branch instead of the default branch.",
    fallback: 'Pin this session\'s Symvanta reads to the branch named above:\n\n$ARGUMENTS\n\nBind the session first when it is unbound (`init` with the checkout\'s GitHub remote). With a branch name, call `ref` with `op: "use"` and `branch` set to it; the branch must already be tracked and indexed, or the call returns `indexing_in_progress` and nothing is pinned. Confirm the revision with `freshness`. With `clear`, call `ref` with `op: "clear"`, which drops the revision pin only.',
  },
  "symvanta-recent": {
    description: "Recent indexed history: the files changing most often, and the latest commits, optionally scoped to one path.",
    fallback: 'Report recent history from the Symvanta index:\n\n$ARGUMENTS\n\nCall `history` with `op: "recently_changed"` for the hot files, and with `op: "commits"` plus `path` when a path is named. Report the top files with their change counts and the recent commit subjects with short sha and date, and state that this is the indexed window rather than all of git history.',
  },
  "symvanta-clear": {
    description: "Drop the Symvanta session pin: the branch or working-tree revision pin by default, and the project binding only when explicitly asked.",
    fallback: 'Clear the Symvanta session pin:\n\n$ARGUMENTS\n\nCall `ref` with `op: "clear"` for the revision pin (a branch or the working-tree overlay) and say which one is gone. Call `ref` with `op: "clear_project"` only when the argument explicitly names the project, and say that later unscoped calls then fall back to the workspace default project. Nothing pinned: `ref` with `op: "clear"` is harmless, but say plainly that there was no pin.',
  },
});

/**
 * The plugin's `commands/` directory, resolved from the loaded module's own
 * URL. A direct Git install, a linked checkout, and a marketplace install all
 * place the extension under `src/`, so the sibling directory is the same one in
 * every install shape.
 *
 * @param {string} moduleUrl the extension module's `import.meta.url`
 */
export function commandDirectory(moduleUrl) {
  return path.join(path.dirname(fileURLToPath(moduleUrl)), "..", "commands");
}

/**
 * Split a command markdown file into its frontmatter description and its body.
 * A file with no frontmatter is all body, and a description that is not there is
 * null rather than an empty string, so a caller can tell the two apart.
 *
 * @param {unknown} text
 * @returns {{ description: string | null, body: string }}
 */
export function parseCommandTemplate(text) {
  const source = typeof text === "string" ? text.replace(/^\uFEFF/, "") : "";
  if (!source.startsWith("---")) return { description: null, body: source.trim() };

  const end = source.indexOf("\n---", 3);
  if (end === -1) return { description: null, body: source.trim() };

  let description = null;
  for (const line of source.slice(3, end).split("\n")) {
    const match = /^description:\s*(.+)$/.exec(line.trim());
    if (match) {
      const value = match[1].trim().replace(/^["']|["']$/g, "");
      if (value.length > 0) description = value;
    }
  }
  return { description, body: source.slice(end + 4).trim() };
}

/**
 * The aggregate placeholders: `$ARGUMENTS`, and `$@` when it is not the head of
 * a positional slice (`$@[1]`, `$@[2:3]`). Defined once so the renderer makes a
 * single pass over the template.
 */
const AGGREGATE_PLACEHOLDER = /\$ARGUMENTS|\$@(?!\[)/g;

/**
 * Render a template for one invocation: `$ARGUMENTS` and `$@` become what the
 * user typed. A template with no aggregate placeholder gets the arguments
 * appended, so a command that mentions its argument in prose still receives it.
 *
 * The substitution is one `replace` call with a callback, for two reasons that
 * both bite a chained `replaceAll`:
 *
 *   - the replacement is inserted verbatim. A string replacement would expand
 *     `$&`, `` $` ``, `$'`, and `$1` in the user's own text, so typing
 *     `sed 's/$1/x/'` would come out mangled;
 *   - one pass means inserted text is never rescanned, so an argument that
 *     itself contains `$ARGUMENTS` or `$@` cannot trigger a second round.
 *
 * @param {string} body the template body, frontmatter already stripped
 * @param {unknown} args the raw argument string the command handler received
 */
export function renderCommandTemplate(body, args) {
  const template = typeof body === "string" ? body : "";
  const value = typeof args === "string" ? args.trim() : "";
  const usesAggregate = AGGREGATE_PLACEHOLDER.test(template);
  AGGREGATE_PLACEHOLDER.lastIndex = 0;

  const rendered = template.replace(AGGREGATE_PLACEHOLDER, () => value);
  return (usesAggregate || value.length === 0 ? rendered : `${rendered}\n\n${value}`).trim();
}

/**
 * The body of one command template: the bundled markdown when it can be read
 * and carries a body, else the built-in fallback. A missing, unreadable, or
 * empty file is not an error here, because a command that cannot render is
 * worse than one that renders the short form.
 *
 * @param {string} name one of SYMVANTA_COMMANDS
 * @param {string} directory the plugin's `commands/` directory
 * @param {(file: string, encoding: string) => string} read injected for tests
 * @returns {string}
 */
export function loadCommandTemplate(name, directory, read = readFileSync) {
  const entry = SYMVANTA_COMMANDS[name];
  if (!entry) return "";
  try {
    const file = path.join(directory, `${name}.md`);
    const parsed = parseCommandTemplate(read(file, "utf8"));
    if (parsed.body.length > 0) return parsed.body;
  } catch {
    // Fall through to the built-in body.
  }
  return entry.fallback;
}
