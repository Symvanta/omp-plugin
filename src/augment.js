/**
 * Guidance-only augmenters for the Symvanta OMP plugin.
 *
 * The Claude plugin shipped an augment hook per feature. The OMP extension does
 * the same job in process: it reads what the model is about to do and injects a
 * short, hidden note that says which graph call would answer the same question
 * without a tree scan.
 *
 * Two rules hold for every builder here, and they are the reason this module is
 * separate from the extension:
 *
 *   - it is advisory. Nothing in this file blocks a tool, rewrites an argument,
 *     or changes a result.
 *   - it is not a graph result. The text says so, because the plugin did not
 *     query Symvanta to produce it and must never imply that it did.
 *
 * Switches (all trimmed and compared without case, off values `off`, `false`,
 * `0`, `no`): SYMVANTA_AUGMENT disables every augmenter, and
 * SYMVANTA_AUGMENT_PROMPT, SYMVANTA_AUGMENT_SEARCH, SYMVANTA_AUGMENT_READ,
 * SYMVANTA_AUGMENT_RESCUE, and SYMVANTA_AUGMENT_DEDUPE disable one each.
 * Dedupe is the odd one out: turning it off repeats guidance instead of
 * suppressing a repeat.
 *
 * This module is pure: it imports one switch helper, reads the environment
 * object it is handed, and performs no I/O.
 */

import { isOffValue } from "./impact.js";

/** The guidance-only features, each with its own switch. */
export const AUGMENT_FEATURES = Object.freeze(["prompt", "search", "read", "rescue", "dedupe"]);

/**
 * How many guidance messages each deduped feature may inject per session, plus
 * the cap across all of them. The bound exists so a model stuck in a loop
 * cannot turn routing advice into the bulk of its context.
 *
 * The prompt augmenter is deliberately absent: it is delivered through the
 * `before_agent_start` return value, which OMP may recompute for the same
 * submission, so it must stay deterministic and hold no session state. Its
 * bound is the number of prompts, not a counter here. A kind missing from this
 * table can never be sent as an aside, which is the safe default.
 */
export const GUIDE_LIMITS = Object.freeze({ search: 6, read: 4, rescue: 4, warn: 4, total: 12 });

/**
 * Whether a guidance-only augmenter may run. The global switch is checked
 * first, so SYMVANTA_AUGMENT=off disables prompt, search, read, and rescue at
 * once, and the per-feature switch is checked after it.
 *
 * @param {Record<string, string | undefined> | undefined} env
 * @param {string} feature one of AUGMENT_FEATURES
 * @returns {boolean}
 */
export function augmentEnabled(env, feature) {
  const source = env && typeof env === "object" ? env : {};
  if (isOffValue(source.SYMVANTA_AUGMENT)) return false;
  if (feature === "dedupe") return !isOffValue(source.SYMVANTA_AUGMENT_DEDUPE);
  if (!AUGMENT_FEATURES.includes(feature)) return false;
  return !isOffValue(source[`SYMVANTA_AUGMENT_${feature.toUpperCase()}`]);
}

/** An identifier with an internal underscore: `read_git_value`, `MAX_GUARD_BLOCKS`. */
const SNAKE_SHAPED = /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+$/;

/** An identifier with a lower-to-upper case boundary: `normalizeAlias`, `ToolAvailability`. */
const CAMEL_SHAPED = /^[A-Za-z][A-Za-z0-9]*[a-z0-9][A-Z][A-Za-z0-9]*$/;

/** Words that are shaped like an identifier but name a convention, not a symbol. */
const NON_SYMBOLS = Object.freeze({
  snake_case: true, camel_case: true, pascal_case: true, kebab_case: true, screaming_snake: true,
});

/**
 * Identifier-shaped tokens in a prompt: the spans a model wrote in backticks
 * first, then bare snake_case and camelCase words when those yielded fewer than
 * the limit. A term is kept only when it is shaped like a symbol, so a path
 * (`src/index.ts`), a prose word (`the`), or an operator cannot be routed as
 * one. At most `limit` terms come back, in the order they were read.
 *
 * @param {unknown} prompt
 * @param {number} limit
 * @returns {string[]}
 */
export function extractPromptTerms(prompt, limit = 2) {
  if (typeof prompt !== "string" || prompt.length === 0 || limit <= 0) return [];

  const terms = [];
  const seen = new Set();
  const consider = (candidate) => {
    const value = candidate.trim();
    if (value.length < 3 || value.length > 64) return;
    if (!SNAKE_SHAPED.test(value) && !CAMEL_SHAPED.test(value)) return;
    const key = value.toLowerCase();
    if (Object.hasOwn(NON_SYMBOLS, key) || seen.has(key)) return;
    seen.add(key);
    terms.push(value);
  };

  for (const match of prompt.matchAll(/`([^`\n]{1,64})`/g)) consider(match[1]);
  if (terms.length < limit) {
    for (const match of prompt.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
      consider(match[0]);
      if (terms.length >= limit) break;
    }
  }
  return terms.slice(0, limit);
}

/**
 * A shell command word that runs a code search: `rg`, `grep`, `ag`, `ack`,
 * `find`, `fd`, or a common alias. The lookarounds keep a substring
 * (`grepable`, `findings`) and an argument from counting as a command.
 */
const SEARCH_COMMAND = /(?:^|[;&|(<>\s])(?:rg|ripgrep|grep|egrep|fgrep|ag|ack|find|fd)(?:\s|$)/;

/**
 * The code search a tool call performs, or null when the call is not one. Three
 * shapes count, and each is read from the field its own input schema declares:
 *
 *   - `grep`: `pattern`, with `path` as the scope it searches
 *   - `glob`: `path`, which *is* the glob, file, or directory being searched
 *     (the glob tool has no `pattern` field, and an omitted path means the
 *     workspace root, which is not a search expression worth routing)
 *   - `bash`: a `command` whose text runs a search binary, with no scope of its
 *     own
 *
 * The scope travels with the target so the note can name it and so two searches
 * for the same pattern in different trees are not deduped into one.
 *
 * @param {unknown} toolName
 * @param {unknown} input
 * @returns {{ tool: string, query: string, scope: string | null } | null}
 */
export function searchTarget(toolName, input) {
  const name = typeof toolName === "string" ? toolName.trim().toLowerCase() : "";
  const record = input && typeof input === "object" && !Array.isArray(input) ? input : {};

  if (name === "grep") {
    const pattern = firstText(record.pattern);
    return pattern === null ? null : { tool: name, query: pattern, scope: firstText(record.path) };
  }
  if (name === "glob") {
    const target = firstText(record.path);
    return target === null ? null : { tool: name, query: target, scope: null };
  }
  if (name === "bash") {
    const command = firstText(record.command);
    if (command === null || !SEARCH_COMMAND.test(command)) return null;
    return { tool: name, query: command.split("\n")[0].slice(0, 80), scope: null };
  }
  return null;
}

/** The routing note a prompt earns: what to resolve before searching locally. */
export function promptGuidance(terms) {
  const named = terms.map((term) => `\`${term}\``).join(" and ");
  return [
    `Symvanta routing (plugin text, not a graph result): this request names ${named}.`,
    "Resolve each one before searching locally: find_node for a symbol (pass path:symbol when the bare name is ambiguous), locate with no mode when the name is fuzzy (it tries a literal query, then a semantic one), and locate mode:config for an environment variable or config key.",
    "A symbol or file answer carries filePath and line bounds, so read the slice rather than the whole file. This is a suggestion, and it assumes this checkout is bound to an indexed project.",
  ].join("\n");
}

/** The routing note a local search earns, phrased for the tool that is about to run. */
export function searchGuidance(target) {
  const query = target && typeof target.query === "string" ? target.query : "";
  const scope = target && typeof target.scope === "string" ? target.scope : null;
  const shown = query.length > 0 ? `\`${query}\`` : "this query";
  const where = scope === null ? "" : ` under \`${scope}\``;
  const head = `Symvanta routing (plugin text, not a graph result): ${shown}${where} may already be indexed.`;

  if (target && target.tool === "glob") {
    return [
      head,
      "locate mode:file matches a file by name fragment and find_node or locate mode:symbol resolves a symbol, both from the graph instead of a tree walk.",
      "Keep the glob when you need the real filesystem (untracked or ignored files), when the checkout is not bound, or when you want to be sure nothing outside the index matches.",
    ].join("\n");
  }

  return [
    head,
    "locate mode:text answers a literal identifier or string, locate with no mode auto-routes a literal then a semantic query, and relate answers callers, dependencies, and blast radius.",
    "Keep the search when you need exact matches, when the index has no coverage, or when the checkout is not bound. This is a suggestion, not a block: no result from this call was altered.",
  ].join("\n");
}

/** The routing note the first read of a code file earns. */
export function readGuidance(relativePath) {
  return [
    `Symvanta routing (plugin text, not a graph result): ${relativePath} is indexed code, and the graph can answer what its symbols are.`,
    "list_file_symbols returns every symbol in the file with its line bounds in one call, so a later read can ask for just that range; find_node also attaches any recorded decisions (adr) for a symbol, which may constrain what this file is allowed to do.",
    "Read the whole file when the graph has no entry for it, or when the task is about text rather than structure.",
  ].join("\n");
}

/** The rescue note an empty, successful grep earns. */
export function rescueGuidance(query) {
  const shown = typeof query === "string" && query.length > 0 ? ` for \`${query}\`` : "";
  return [
    `Symvanta rescue (plugin text, not a graph result): this grep found no matches${shown}.`,
    "Do not retry it reworded. locate with no mode auto-routes a literal query and then a semantic one, and locate mode:semantic takes a behavior-shaped description rather than an identifier.",
    "If locate is empty too, the graph has no coverage for it and local search is the right fallback; say which of the two it was rather than reporting the symbol as missing.",
  ].join("\n");
}

/** The dedupe key for one piece of guidance: kind first, then the normalized subject. */
export function guideKey(kind, subject) {
  const value = typeof subject === "string" ? subject.trim().toLowerCase().replace(/\s+/g, " ") : "";
  return `${kind}:${value}`;
}

/** The first non-empty trimmed string among the candidates, or null. */
function firstText(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  return null;
}
