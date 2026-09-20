/**
 * Observation-only status for the Symvanta OMP plugin.
 *
 * The Claude plugin ran a status hook that shelled out to a stats program and,
 * failing that, read a local log file. OMP needs neither: the session already
 * receives the payloads, so the widget is a view over results that arrived.
 *
 * Three tool results feed it, and only these:
 *
 *   init          the bound project, the checkout's workspace entry, and the
 *                 project's indexed repositories
 *   freshness     one repository's indexed sha, remote sha, and staleness
 *   index_health  per-project unindexable, degraded, pending, and drift lists
 *
 * Every field is read defensively from the result the session was handed: the
 * structured `details` when the host carried them, otherwise the JSON block
 * Symvanta appends to its text. A field that is absent is not shown, and
 * nothing is concluded from a field that was not there. This module never
 * contacts Symvanta, never reads a credential, and never says more than the
 * payload said.
 *
 * This module has no imports and performs no I/O.
 */

/** The bare Symvanta tool names whose successful results feed the widget. */
export const STATUS_TOOL_NAMES = Object.freeze(["init", "freshness", "index_health"]);

/**
 * Fields that identify each payload. A nested object is only accepted as the
 * payload when it carries at least one of them, so an unrelated `details`
 * object (a truncated `meta`, say) cannot be mistaken for one.
 */
const PAYLOAD_KEYS = Object.freeze({
  init: ["workspace", "project", "repositories"],
  freshness: ["lastIndexedSha", "currentRemoteSha", "isStale", "writePending", "repository"],
  index_health: ["unindexableRepositories", "degradedRepositories", "pendingLibraryVersions", "architecture"],
});

/** Keys a host may use to nest the structured payload one level down. */
const CONTAINER_KEYS = Object.freeze(["structuredContent", "structured_content", "data", "result", "payload"]);

/** A text block is only scanned for JSON below this size, so a large dump is never parsed. */
const MAX_JSON_SCAN = 512 * 1024;

/** A fenced JSON block, which is how Symvanta appends structured output to its text. */
const JSON_FENCE = /```json[ \t]*\r?\n([\s\S]*?)```/;

/** At most this many widget lines, and at most this many characters each. */
const MAX_LINES = 3;
const MAX_LINE = 120;

/**
 * The status one tool result justifies, or null when it justifies none.
 *
 * `attached` carries what an `init` result observed about the checkout
 * (`workspace.attached`), and null for the two tools whose payloads do not
 * describe it: the caller uses it to gate guidance and the impact guard, so it
 * must never be inferred from anything else.
 *
 * @param {unknown} toolName bare Symvanta tool name (`init`, `freshness`, `index_health`)
 * @param {unknown} event the `tool_result` event
 * @returns {{ text: string | null, lines: string[], attached: boolean | null } | null}
 */
export function statusFromToolResult(toolName, event) {
  try {
    const name = typeof toolName === "string" ? toolName.trim().toLowerCase() : "";
    if (!STATUS_TOOL_NAMES.includes(name)) return null;

    const record = plain(event);
    if (record === null) return null;
    if (record.isError === true || typeof record.error === "string") return null;

    const payload = payloadOf(record, PAYLOAD_KEYS[name]);
    if (payload === null) return null;

    const status = name === "freshness" ? freshnessStatus(payload)
      : name === "init" ? initStatus(payload)
      : indexHealthStatus(payload);
    if (status === null) return null;

    const lines = status.lines.slice(0, MAX_LINES).map((line) => truncate(line));
    const footerText = status.text === null ? null : truncate(status.text);
    if (footerText === null && lines.length === 0) return null;
    return { text: footerText, lines, attached: status.attached === true ? true : status.attached === false ? false : null };
  } catch {
    return null;
  }
}

/** `freshness`: one repository's indexed revision against its remote head. */
function freshnessStatus(payload) {
  const repository = repositoryName(payload.repository) ?? text(payload.repositoryName) ?? text(payload.fullName);
  const indexed = shortSha(payload.lastIndexedSha ?? payload.indexedSha ?? payload.commitSha);
  const remote = shortSha(payload.currentRemoteSha ?? payload.remoteSha ?? payload.headSha);
  const pinned = text(payload.pinnedBranch) ?? shortSha(payload.pinnedSha);
  const state = payload.isStale === true ? "stale" : payload.isStale === false ? "fresh" : null;
  const pending = payload.writePending === true || payload.write_pending === true;
  const at = instant(payload.lastIndexedAt ?? payload.indexedAt);

  const short = repoTail(repository);
  const footerText = footer(short, state ?? (pending ? "write pending" : null));

  const lines = [`Symvanta: ${repository ?? "freshness"}${state === null ? "" : ` (${state})`}${pending ? " · write pending" : ""}`];
  const revisions = [indexed === null ? null : `indexed ${indexed}`, remote === null ? null : `remote ${remote}`, pinned === null ? null : `pinned ${pinned}`];
  const revisionLine = revisions.filter((part) => part !== null).join(" · ");
  if (revisionLine.length > 0) lines.push(revisionLine);
  if (at !== null) lines.push(`last indexed ${at}`);

  return { text: footerText, lines };
}

/** `init`: the bound project, whether this checkout is attached, and its repositories. */
function initStatus(payload) {
  const workspace = plain(payload.workspace) ?? {};
  const project = plain(payload.project) ?? {};
  const repository = text(workspace.repository) ?? text(payload.repository);
  // Observed, never inferred: the field is a boolean or nothing at all.
  const attached = workspace.attached === true ? true : workspace.attached === false ? false : null;
  const repositories = Array.isArray(payload.repositories) ? payload.repositories : null;
  const projectName = text(project.name);
  const pinned = workspace.pinned === true;

  const short = repoTail(repository);
  const state = attached === false ? "not attached" : attached === true ? "attached" : null;
  const footerText = footer(short ?? projectName, state);

  const head = repository === null
    ? "Symvanta: project"
    : `Symvanta: ${repository}${attached === null ? "" : attached ? " (attached)" : " (not attached)"}`;
  const lines = [head];
  const details = [
    projectName === null ? null : `project ${projectName}`,
    repositories === null ? null : `${repositories.length} repositories`,
    pinned ? "project pinned" : null,
  ].filter((part) => part !== null);
  if (details.length > 0) lines.push(details.join(" · "));

  return { text: footerText, lines, attached };
}

/** `index_health`: the per-project lists that explain a silent or degraded index. */
function indexHealthStatus(payload) {
  const unindexable = count(payload.unindexableRepositories);
  const degraded = count(payload.degradedRepositories);
  const pending = count(payload.pendingLibraryVersions);
  const drift = count(payload.versionDrift);
  const repositories = count(payload.architecture);

  const parts = [
    unindexable === null ? null : `${unindexable} unindexable`,
    degraded === null ? null : `${degraded} degraded`,
    drift === null ? null : `${drift} version drift`,
  ].filter((part) => part !== null);
  if (parts.length === 0 && pending === null && repositories === null) return null;

  const footerText = `symvanta: ${parts.length > 0 ? parts.join(" · ") : `${pending ?? 0} pending versions`}`;
  const lines = [];
  if (parts.length > 0) lines.push(`Symvanta index health: ${parts.join(" · ")}`);
  if (pending !== null && pending > 0) lines.push(`${pending} pending library versions`);
  if (repositories !== null) lines.push(`${repositories} repositories with an architecture row`);

  return { text: footerText, lines };
}

/** The compact footer text: the stable `symvanta:` prefix, the subject, and one observed state. */
function footer(subject, state) {
  const parts = [subject, state].filter((part) => typeof part === "string" && part.length > 0);
  return parts.length === 0 ? null : `symvanta: ${parts.join(" · ")}`;
}

/**
 * The structured payload of a result: `details` when it carries one of the
 * fields this tool is known for, otherwise the fenced JSON block Symvanta
 * appends to its text. Returns null rather than a guess when neither is usable.
 */
function payloadOf(record, keys) {
  const nested = findPayload(record.details, keys, 0);
  if (nested !== null) return nested;

  const blocks = record.content;
  if (!Array.isArray(blocks)) return null;
  for (const block of blocks) {
    const body = plain(block);
    if (body === null || typeof body.text !== "string" || body.text.length > MAX_JSON_SCAN) continue;
    const parsed = parseFencedJson(body.text);
    if (parsed !== null && holdsAny(parsed, keys)) return parsed;
  }
  return null;
}

/** Depth-bounded search for the object that carries one of this tool's fields. */
function findPayload(value, keys, depth) {
  const current = plain(value);
  if (current === null || depth > 2) return null;
  if (holdsAny(current, keys)) return current;

  for (const key of CONTAINER_KEYS) {
    const found = findPayload(current[key], keys, depth + 1);
    if (found !== null) return found;
  }
  for (const child of Object.values(current)) {
    const candidate = plain(child);
    if (candidate !== null && holdsAny(candidate, keys)) return candidate;
  }
  return null;
}

/** The first fenced JSON object in a text block, or null when there is none or it does not parse. */
function parseFencedJson(body) {
  const fenced = JSON_FENCE.exec(body);
  if (fenced === null) return null;
  try {
    return plain(JSON.parse(fenced[1]));
  } catch {
    return null;
  }
}

/** Whether an object carries any of the fields that identify the payload. */
function holdsAny(value, keys) {
  return keys.some((key) => value[key] !== undefined);
}

/** A non-null, non-array object, or null. */
function plain(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** A trimmed non-empty string, or null. */
function text(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** `fullName` when a repository is an object, else null. */
function repositoryName(value) {
  const repo = plain(value);
  if (repo === null) return null;
  return text(repo.fullName) ?? text(repo.repositoryName) ?? text(repo.name);
}

/** The repository's own name: `Symvanta/omp-plugin` reads as `omp-plugin`. */
function repoTail(repository) {
  const value = text(repository);
  if (value === null) return null;
  const tail = value.split("/").filter((part) => part.length > 0).pop();
  return tail ?? null;
}

/** A revision as its first eight characters, or null when the value is not a sha-shaped string. */
function shortSha(value) {
  const sha = text(value);
  if (sha === null || sha.length < 7 || sha.length > 64) return null;
  return /^[0-9a-fA-F]+$/.test(sha) ? sha.slice(0, 8).toLowerCase() : null;
}

/** The length of a list, or null when the value is not one. */
function count(value) {
  return Array.isArray(value) ? value.length : null;
}

/**
 * A timestamp as a short date. Symvanta sends ISO strings and, in `init`,
 * unix seconds; both are real observations, so both are shown, and anything
 * that does not resolve to a valid date is dropped rather than printed.
 */
function instant(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return /^\d{4}-\d{2}-\d{2}/.test(trimmed) ? trimmed.slice(0, 10) : null;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const milliseconds = value > 1e12 ? value : value > 1e9 ? value * 1000 : null;
    if (milliseconds === null) return null;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }
  return null;
}

/** One widget line, bounded so a long repository name cannot span the editor. */
function truncate(line) {
  const value = typeof line === "string" ? line.replace(/\s+/g, " ").trim() : "";
  return value.length > MAX_LINE ? `${value.slice(0, MAX_LINE - 1)}…` : value;
}
