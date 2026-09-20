/**
 * Pure helpers for the Symvanta OMP plugin: GitHub remote parsing and the
 * startup binding context.
 *
 * This file has no imports and performs no I/O. The extension in src/index.ts
 * spawns git and hands the raw origin URL here, which keeps the interesting
 * rules (which remotes count, what the agent is told) testable and side-effect
 * free.
 *
 * OMP plugin note: the Claude plugin shipped these rules inside hooks/*.js
 * subprocesses that parsed hook stdin. OMP extensions are in-process modules,
 * so there is no hook envelope to parse here, only the URL string itself.
 */

const GITHUB_HOSTS = { "github.com": true, "www.github.com": true };

/** GitHub owner and repository segments accept these characters. */
const SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * @param {unknown} value
 * @returns {string | null} trimmed text, or null when there is nothing usable
 */
function text(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Reduce any git remote URL form to its host and path:
 * `https://github.com/a/b.git`, `ssh://git@github.com:22/a/b`, the scp-style
 * `git@github.com:a/b`, and the bare `github.com/a/b` all resolve here.
 *
 * @param {string} raw
 * @returns {{ host: string, path: string } | null}
 */
function hostAndPath(raw) {
  const trimmed = raw.trim().replace(/\/+$/, "");
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(trimmed);

  if (!scheme) {
    const scp = /^[^/@\s]+@([^/:\s]+):(.+)$/.exec(trimmed);
    if (scp) return { host: scp[1].toLowerCase(), path: scp[2] };
    const bare = /^([^/:\s]+)\/(.+)$/.exec(trimmed);
    if (bare) return { host: bare[1].toLowerCase(), path: bare[2] };
    return null;
  }

  const rest = trimmed.slice(scheme[0].length);
  const slash = rest.indexOf("/");
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? "" : rest.slice(slash + 1);
  const at = authority.lastIndexOf("@");
  const host = (at === -1 ? authority : authority.slice(at + 1)).replace(/:\d+$/, "").toLowerCase();
  return { host, path };
}

/**
 * `owner/name` for a GitHub remote URL, or null when the URL is not a plain
 * GitHub repository remote (another host, another forge, malformed, or a URL
 * that addresses something inside a repository rather than the repository).
 * Mirrors the server's normalizeRepositorySlug so init resolves the same
 * repository this checkout is on.
 *
 * @param {unknown} url
 * @returns {{ owner: string, name: string, slug: string } | null}
 */
export function parseGitHubRemote(url) {
  const raw = text(url);
  if (!raw) return null;

  const split = hostAndPath(raw);
  if (!split || !Object.hasOwn(GITHUB_HOSTS, split.host)) return null;

  const cleaned = split.path.replace(/\/+$/, "").replace(/\.git$/i, "");
  const segments = cleaned.split("/").filter((part) => part.length > 0);
  if (segments.length !== 2) return null;

  const [owner, name] = segments;
  if (!SEGMENT.test(owner) || !SEGMENT.test(name)) return null;
  if (owner === "." || owner === ".." || name === "." || name === "..") return null;

  return { owner, name, slug: `${owner}/${name}` };
}

/**
 * The hidden startup context queued on session_start. Three checkout shapes,
 * because which project `init` should bind the session to depends on the tree:
 *
 * - a GitHub checkout: bind through `init({ repository })`;
 * - a checkout with no GitHub remote: Symvanta cannot index it, say so;
 * - not a checkout (a workspace root holding several checkouts, a scratch
 *   directory): plain `init`, the workspace default or pinned project decides.
 *
 * @param {{ slug?: string | null, isCheckout?: boolean }} [info]
 * @returns {string}
 */
export function buildStartupContext(info = {}) {
  const slug = text(info.slug);

  if (slug) {
    return [
      `Call the Symvanta \`init\` tool once, with repository: "${slug}" (this checkout's GitHub remote).`,
      "init binds this session to the project that holds this checkout and reports it as the active project, so later calls without projectId resolve there.",
      "If init answers workspace.attached=false, this checkout is not indexed: nothing init reports describes it, so keep working here with Read, Grep, and lsp, and offer to attach it (add_repository; a private repository needs installation_id from list_installations, and create_project first when it needs its own project).",
      "Once init reports the checkout as an indexed repository, route code navigation and impact analysis through the Symvanta graph as the always-apply symvanta rule describes.",
    ].join(" ");
  }

  if (info.isCheckout === true) {
    return [
      "This directory is a git checkout whose remote is not a GitHub repository, so Symvanta cannot index this tree.",
      "Call the Symvanta `init` tool only to see the workspace's other projects; nothing it reports describes this checkout, so work here with the local tools (Read, Grep, lsp).",
    ].join(" ");
  }

  return [
    "This directory is not a git checkout (a workspace root holding several checkouts, or a scratch directory).",
    "Call the Symvanta `init` tool without repository: the active project is the workspace default or the session's pinned project (project_source says which).",
    "To bind to one checkout under it, pass that checkout's GitHub remote as repository.",
  ].join(" ");
}
