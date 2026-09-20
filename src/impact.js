/**
 * Impact-guard modes for the Symvanta OMP plugin.
 *
 * The Claude plugin enforced the pre-edit blast-radius check in a subprocess
 * hook that could only allow or deny. The OMP extension keeps that refusal but
 * makes its strength a setting, because a refusal and a warning fail in
 * different directions: a refusal can wedge a session that cannot satisfy it,
 * and a warning can be ignored.
 *
 *   once    refuse the first unchecked mutation of an existing code file, then
 *           fail open (the historical behavior, and the default)
 *   strict  keep refusing until a Symvanta impact check completes successfully
 *   warn    never refuse; inject hidden guidance beside the mutation instead
 *   off     do nothing at all
 *
 * SYMVANTA_IMPACT_MODE selects the mode. A value that names no mode, including
 * unset and empty, falls back to the legacy switch: SYMVANTA_ENFORCE_IMPACT in
 * {off, false, 0, no} maps to `off`, and anything else to `once`. That keeps an
 * existing `SYMVANTA_ENFORCE_IMPACT=off` in a shell profile working, while an
 * explicit SYMVANTA_IMPACT_MODE always wins.
 *
 * This module is pure: it reads the environment object it is handed, imports
 * nothing, and performs no I/O. The extension parses the mode once per session
 * and hands the result to the decisions below.
 */

/** The modes, so a caller can validate or document them without repeating the list. */
export const IMPACT_MODES = Object.freeze(["once", "strict", "warn", "off"]);

/** Values that switch a toggle off, shared with the augmentation switches. */
const OFF_VALUES = Object.freeze({ off: true, false: true, "0": true, no: true });

/**
 * Whether a switch value reads as "off": trimmed and compared without case, so
 * `OFF`, ` off `, and `false` all disable. Anything else (including undefined)
 * leaves the switch on.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isOffValue(value) {
  return typeof value === "string" && Object.hasOwn(OFF_VALUES, value.trim().toLowerCase());
}

/**
 * The impact mode this session runs in. An explicit SYMVANTA_IMPACT_MODE wins
 * when it names a mode; otherwise the legacy switch decides, and its absence
 * means `once`.
 *
 * @param {Record<string, string | undefined> | undefined} env
 * @returns {"once" | "strict" | "warn" | "off"}
 */
export function parseImpactMode(env) {
  const source = env && typeof env === "object" ? env : {};
  const declared = typeof source.SYMVANTA_IMPACT_MODE === "string" ? source.SYMVANTA_IMPACT_MODE.trim().toLowerCase() : "";
  if (IMPACT_MODES.includes(declared)) return declared;
  return isOffValue(source.SYMVANTA_ENFORCE_IMPACT) ? "off" : "once";
}

/** Whether this mode can refuse a mutation at all. */
export function impactBlocks(mode) {
  return mode === "once" || mode === "strict";
}

/**
 * How many mutations this mode may refuse before it fails open. `Infinity` is
 * strict: it never fails open, which is the point of asking for it. `once`
 * yields the caller's historical cap of one, and the advisory and disabled
 * modes refuse nothing.
 *
 * @param {string} mode
 * @param {number} onceLimit refusals the `once` mode allows
 */
export function impactBlockLimit(mode, onceLimit) {
  if (mode === "strict") return Number.POSITIVE_INFINITY;
  if (mode === "once") return onceLimit;
  return 0;
}

/**
 * The hidden guidance the `warn` mode injects beside an unchecked mutation.
 * It is guidance, not enforcement: the call it describes was never blocked, and
 * no graph tool ran to produce this text.
 *
 * @param {string} relativePath the file the mutation targets, as the guard sees it
 * @param {{ relate: boolean, estimateScope: boolean }} tools the Symvanta tools this session has
 * @returns {string}
 */
export function warnGuidance(relativePath, tools) {
  const options = [];
  if (tools && tools.estimateScope) options.push("estimate_scope for a task-level estimate");
  if (tools && tools.relate) options.push('relate with kind "blast_radius" for the symbol this change touches');
  const check = options.length > 0 ? options.join(", or ") : "a Symvanta impact check";

  return [
    `Symvanta impact warning (SYMVANTA_IMPACT_MODE=warn): ${relativePath} already exists and no Symvanta impact check has run in this session.`,
    `This is plugin guidance from the edit itself, not a graph result, and the mutation was not blocked. Run ${check}, then carry on.`,
    "SYMVANTA_IMPACT_MODE=once restores the one-refusal guard, strict refuses until a check succeeds, and off turns the guard off entirely.",
  ].join("\n");
}
