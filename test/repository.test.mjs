// Tests for src/repository.js: GitHub remote parsing and the startup primer.
//
// The helper is pure (no imports, no I/O), so these are plain function calls:
// nothing here spawns git, touches the network, or reads credentials. Node
// built-ins only, run with `node --test`.

import assert from "node:assert/strict";
import test from "node:test";

import { buildStartupContext, parseGitHubRemote } from "../src/repository.js";

/** Every remote form a real checkout can carry must resolve to the same slug. */
const EQUIVALENT_REMOTES = [
  ["https url", "https://github.com/Symvanta/omp-plugin.git"],
  ["https url without .git", "https://github.com/Symvanta/omp-plugin"],
  ["https url with trailing slash", "https://github.com/Symvanta/omp-plugin/"],
  ["https url with credentials", "https://user:ghp_token@github.com/Symvanta/omp-plugin.git"],
  ["https url with explicit port", "https://github.com:443/Symvanta/omp-plugin.git"],
  ["https url with surrounding whitespace", "  https://github.com/Symvanta/omp-plugin.git\n"],
  ["www host", "https://www.github.com/Symvanta/omp-plugin.git"],
  ["uppercase host", "https://GitHub.COM/Symvanta/omp-plugin.git"],
  ["uppercase scheme", "HTTPS://github.com/Symvanta/omp-plugin.git"],
  ["git protocol", "git://github.com/Symvanta/omp-plugin.git"],
  ["uppercase .git suffix", "https://github.com/Symvanta/omp-plugin.GIT"],
  ["git+ssh url", "git+ssh://git@github.com/Symvanta/omp-plugin.git"],
  ["ssh url", "ssh://git@github.com/Symvanta/omp-plugin.git"],
  ["ssh url with port", "ssh://git@github.com:22/Symvanta/omp-plugin.git"],
  ["scp style", "git@github.com:Symvanta/omp-plugin.git"],
  ["scp style without .git", "deploy@github.com:Symvanta/omp-plugin"],
  ["bare host and path", "github.com/Symvanta/omp-plugin"],
  ["bare host and path with .git", "www.github.com/Symvanta/omp-plugin.git"],
];

const SLUG = "Symvanta/omp-plugin";

test("parseGitHubRemote resolves every GitHub remote form to one owner/name", () => {
  for (const [label, remote] of EQUIVALENT_REMOTES) {
    assert.deepEqual(
      parseGitHubRemote(remote),
      { owner: "Symvanta", name: "omp-plugin", slug: SLUG },
      `${label} (${JSON.stringify(remote)}) must parse to ${SLUG}`,
    );
  }
});

test("parseGitHubRemote keeps owner and repository case but lowercases the host", () => {
  const expected = { owner: "My_Org.Name", name: "Repo_Name", slug: "My_Org.Name/Repo_Name" };

  assert.deepEqual(parseGitHubRemote("https://GitHub.Com/My_Org.Name/Repo_Name.git"), expected);
  assert.deepEqual(parseGitHubRemote("GITHUB.COM/My_Org.Name/Repo_Name"), expected, "a bare host is case-insensitive");
});

test("parseGitHubRemote rejects remotes that are not a GitHub repository root", () => {
  const rejected = [
    ["another forge", "https://gitlab.com/Symvanta/omp-plugin.git"],
    ["a GitHub subdomain that is not github.com", "https://gitlab.github.com/Symvanta/omp-plugin"],
    ["a lookalike host", "https://github.com.example.com/Symvanta/omp-plugin.git"],
    ["a lookalike host with the scp form", "git@github.com.evil.example:Symvanta/omp-plugin.git"],
    ["bitbucket", "https://bitbucket.org/Symvanta/omp-plugin.git"],
    ["a nested tree url", "https://github.com/Symvanta/omp-plugin/tree/main/src"],
    ["a nested blob url", "https://github.com/Symvanta/omp-plugin/blob/main/README.md"],
    ["a nested issues url", "https://github.com/Symvanta/omp-plugin/issues/12"],
    ["a nested url under a .git clone url", "https://github.com/Symvanta/omp-plugin.git/tree/main"],
    ["a nested url with query", "https://github.com/Symvanta/omp-plugin/issues?q=is%3Aopen"],
    ["a commit url", "https://github.com/Symvanta/omp-plugin/commit/abc123"],
    ["an owner with no repository", "https://github.com/Symvanta"],
    ["an owner with no repository and a slash", "https://github.com/Symvanta/"],
    ["three path segments", "https://github.com/Symvanta/omp-plugin/extra"],
    ["a path with a space", "https://github.com/Symvanta/omp plugin"],
    ["a path with a fragment", "https://github.com/Symvanta/omp-plugin#readme"],
    ["a parent-directory segment", "https://github.com/Symvanta/.."],
    ["a current-directory owner", "https://github.com/./omp-plugin"],
    ["a bare host", "github.com"],
    ["a bare host with a slash", "github.com/"],
    ["a host only", "https://github.com"],
    ["a host with a slash only", "https://github.com/"],
    ["an empty string", ""],
    ["whitespace only", "   \t\n"],
    ["a colon without a path", "git@github.com:"],
    ["a file url", "file:///home/ugur/Projects/Symvanta/omp-plugin"],
    ["a local path", "/home/ugur/Projects/Symvanta/omp-plugin"],
    ["a relative path", "./Symvanta/omp-plugin"],
  ];

  for (const [label, remote] of rejected) {
    assert.equal(parseGitHubRemote(remote), null, `${label} (${JSON.stringify(remote)}) must not parse`);
  }
});

test("parseGitHubRemote ignores non-string input instead of throwing", () => {
  for (const value of [null, undefined, 42, true, {}, [], () => {}, Symbol("slug")]) {
    assert.equal(parseGitHubRemote(value), null, `${String(value)} must not parse`);
  }
});

test("the GitHub slug primer binds init to this checkout", () => {
  const primer = buildStartupContext({ slug: SLUG, isCheckout: true });

  assert.match(primer, /init/, "the primer must tell the agent to call init");
  assert.ok(primer.includes(SLUG), `the primer must carry the slug ${SLUG}`);
  assert.match(primer, /repository/, "init must be called with a repository argument");
  assert.match(primer, /workspace\.attached/, "the primer must name the not-indexed signal");
  assert.match(primer, /add_repository/, "an unindexed checkout must be attachable");
  assert.match(primer, /list_installations/, "a private repository needs installation_id");
  assert.match(primer, /always-apply/i, "the primer must point at the always-apply rule");

  assert.doesNotMatch(primer, /not a git checkout/, "a GitHub checkout is not the unbound branch");
  assert.doesNotMatch(primer, /remote is not a GitHub repository/, "a GitHub checkout is not the foreign-remote branch");
});

test("the slug primer trims surrounding whitespace and wins over the checkout shape", () => {
  const primer = buildStartupContext({ slug: `  ${SLUG}  `, isCheckout: false });
  assert.ok(primer.includes(SLUG), "a padded slug must still bind to the trimmed repository");
  assert.match(primer, /init/, "a slug is enough to bind, checkout or not");
});

test("a checkout without a GitHub remote is reported as unindexable", () => {
  const primer = buildStartupContext({ slug: null, isCheckout: true });

  assert.match(primer, /git checkout/, "the primer must say this directory is a checkout");
  assert.match(primer, /not a GitHub repository/, "the primer must say why Symvanta cannot index it");
  assert.match(primer, /init/, "init is still offered for the workspace's other projects");
  assert.match(primer, /(Read|Grep|lsp)/, "local tools must be named as the fallback");
  assert.doesNotMatch(primer, /workspace root/, "a checkout is not the not-a-checkout branch");
});

test("a blank or non-string slug falls back to the checkout shape", () => {
  for (const slug of ["", "   ", null, undefined, 42, {}]) {
    const primer = buildStartupContext({ slug, isCheckout: true });
    assert.match(primer, /not a GitHub repository/, `slug ${JSON.stringify(slug)} must not bind a repository`);
    assert.doesNotMatch(primer, /repository: "/, `slug ${JSON.stringify(slug)} must not quote a repository`);
  }
});

test("a directory that is not a checkout gets the unbound primer", () => {
  const primer = buildStartupContext();

  assert.match(primer, /not a git checkout/, "the primer must say this is not a checkout");
  assert.match(primer, /init/, "init is the binding call");
  assert.match(primer, /without repository/, "init must be called without a repository here");
  assert.match(primer, /project_source/, "the primer must say where the active project came from");
  assert.match(primer, /repository/, "a checkout under the workspace can still be bound explicitly");
  assert.doesNotMatch(primer, /workspace\.attached/, "the unbound branch has no attachment answer to explain");
});

test("only a literal isCheckout:true selects the checkout branch", () => {
  for (const isCheckout of [false, undefined, null, 0, "true", 1, {}]) {
    const primer = buildStartupContext({ isCheckout });
    assert.match(
      primer,
      /not a git checkout/,
      `isCheckout ${JSON.stringify(isCheckout)} must not claim a checkout`,
    );
  }
});

test("every primer branch is non-empty prose with no template placeholders", () => {
  const primers = [
    buildStartupContext({ slug: SLUG, isCheckout: true }),
    buildStartupContext({ isCheckout: true }),
    buildStartupContext(),
  ];

  for (const primer of primers) {
    assert.equal(typeof primer, "string");
    assert.ok(primer.trim().length > 40, "a primer must carry real instructions");
    assert.doesNotMatch(primer, /\$\{|\bundefined\b|\bnull\b|\bNaN\b/, "a primer must not leak a placeholder value");
  }

  assert.equal(new Set(primers).size, 3, "the three checkout shapes must produce three different primers");
});
