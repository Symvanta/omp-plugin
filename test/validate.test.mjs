// Tests for scripts/validate.mjs and the static contract of the shipped plugin.
//
// Two layers:
//   1. the validator itself — the real tree passes, and each rule still fires
//      when exactly one file is broken through withOverrides;
//   2. the artifacts the validator cannot see — the shipped file set, the absent
//      marketplace catalog, the direct Git install the README documents, and the
//      extension's static contract (in-process events, toolCallId-keyed impact
//      tracking, defensive tool-name resolution, apply_patch target parsing, the
//      session-switch primer, no HTTP client and no credential reads).
//
// Node built-ins only, no network, no git: run with `node --test`.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  COMMANDS,
  EXTENSION_ENTRIES,
  INSTALL_COMMAND,
  MCP_TIMEOUT_MS,
  MCP_URL,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  PLUGIN_NAME,
  UNINSTALL_COMMAND,
  collectViolations,
  projectFromDisk,
  projectRoot,
  withOverrides,
} from "../scripts/validate.mjs";

const ROOT = projectRoot();
const SHIPPED = projectFromDisk(ROOT);

const EXTENSION_FILE = "src/index.ts";
const REPOSITORY_MODULE = "src/repository.js";
const RULE_FILE = "rules/symvanta.md";
const SKILL_FILE = "skills/symvanta/SKILL.md";
const CATALOG_FILES = [".omp-plugin/marketplace.json", ".claude-plugin/marketplace.json", "marketplace.json"];
const MARKETPLACE_DOC_HEADING = "## Marketplace namespacing";

/** package.json files entries the release must ship, verbatim. */
const PACKAGE_FILES = [".mcp.json", "LICENSE", "README.md", "commands", "rules", "scripts", "skills", "src"];

/** Every artifact the plugin promises, whether or not package.json lists it. */
const SHIPPED_ARTIFACTS = [
  EXTENSION_FILE,
  REPOSITORY_MODULE,
  RULE_FILE,
  SKILL_FILE,
  ".mcp.json",
  "README.md",
  "LICENSE",
  "scripts/validate.mjs",
  ...COMMANDS.map((command) => `commands/${command}.md`),
];

// ------------------------------------------------------------------- helpers

function read(rel) {
  const text = SHIPPED.read(rel);
  assert.notEqual(text, undefined, `${rel} must exist in the shipped tree`);
  return text;
}

/** The shipped tree's own violations: an injected break is measured against this. */
const BASELINE = collectViolations(SHIPPED);

function violationsFor(overrides) {
  return collectViolations(withOverrides(SHIPPED, overrides));
}

function codesOf(violations) {
  return violations.map((violation) => violation.split(":")[0]);
}

function report(violations) {
  return violations.length > 0 ? `\n  ${violations.join("\n  ")}` : " (none)";
}

/** Violations the override added, and shipped ones it removed, as multisets. */
function diffFromBaseline(violations) {
  const remaining = [...BASELINE];
  const added = [];
  for (const violation of violations) {
    const index = remaining.indexOf(violation);
    if (index === -1) added.push(violation);
    else remaining.splice(index, 1);
  }
  return { added, removed: remaining };
}

/** The injected break must be reported under this code. */
function expectCode(violations, code) {
  assert.ok(codesOf(violations).includes(code), `expected a ${code} violation, got:${report(violations)}`);
}

/** The injected break must be reported under this code, with this text in the message. */
function expectMessage(violations, code, text) {
  const match = violations.find((violation) => violation.startsWith(`${code}:`) && violation.includes(text));
  assert.ok(match, `expected a ${code} violation mentioning ${JSON.stringify(text)}, got:${report(violations)}`);
}

/** The injected break must be the only thing the override changes. */
function expectOnly(violations, code) {
  const { added, removed } = diffFromBaseline(violations);
  assert.ok(added.length > 0, `expected a ${code} violation, got:${report(violations)}`);
  for (const violation of added) {
    assert.equal(violation.split(":")[0], code, `expected only ${code} violations, got:${report(violations)}`);
  }
  assert.deepEqual(removed, [], `expected the override to hide no shipped violation, got:${report(removed)}`);
}

/** Comments are stripped the way the validator strips them, so prose cannot trip a scan. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

/** The braced block that starts at or after `from`, with its braces balanced. */
function blockAt(source, from, what) {
  const start = source.indexOf("{", from);
  assert.notEqual(start, -1, `${what} must have a body`);
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return assert.fail(`${what} body is unterminated`);
}

/** Source text of one `pi.on("<event>", …)` handler. */
function handlerBody(source, event) {
  const marker = new RegExp(`\\.on\\(\\s*["'\`]${event}["'\`]`);
  const match = marker.exec(source);
  assert.ok(match, `${EXTENSION_FILE} must register a ${event} handler`);
  return blockAt(source, match.index + match[0].length, `${event} handler`);
}

/** Source text of one top-level `function <name>(…)` declaration. */
function functionBody(source, name) {
  const marker = new RegExp(`function\\s+${name}\\s*\\(`);
  const match = marker.exec(source);
  assert.ok(match, `${EXTENSION_FILE} must define ${name}`);
  return blockAt(source, match.index + match[0].length, name);
}

/**
 * One `/pattern/flags` literal declared in the extension, as source text. The
 * literal is executable as it stands, so the matcher below can run it for real
 * instead of restating the pattern here.
 */
function regexLiteral(source, name) {
  const match = new RegExp(`const ${name} = (/.+/[a-z]*);`).exec(source);
  assert.ok(match, `${EXTENSION_FILE} must declare ${name}`);
  const literal = match[1];
  const end = literal.lastIndexOf("/");
  const flags = literal.slice(end + 1);
  assert.match(flags, /^[gimsuy]*$/, `${name} must be a plain regex literal, found ${literal}`);
  return { pattern: literal.slice(1, end), flags };
}

/** A fresh matcher for a lifted literal: a `g` regex carries lastIndex between calls. */
function matcher(literal) {
  return new RegExp(literal.pattern, literal.flags);
}

/**
 * One regex literal from the raw extension source. The literal is read before
 * comment stripping, which would otherwise read the `//` an escaped slash plus a
 * closing delimiter produce (`/^file:\/\//i`) as a line comment.
 */
function extensionLiteral(name) {
  return regexLiteral(read(EXTENSION_FILE), name);
}

/** A catalog entry shaped like the one this release deleted, for the return-path tests. */
function catalogFixture(source = { source: "github", repo: "Symvanta/omp-plugin" }) {
  return JSON.stringify(
    {
      name: "symvanta-omp",
      owner: { name: "Symvanta" },
      plugins: [{ name: PLUGIN_NAME, description: "Symvanta plugin.", version: PACKAGE_VERSION, source }],
    },
    null,
    2,
  );
}

/** The README with the namespacing section a returning catalog must be documented by. */
function readmeWithNamespaceDocs() {
  return `${read("README.md")}\n${MARKETPLACE_DOC_HEADING}\n\nMarketplace installs are namespaced: OMP prefixes the command names and the MCP server name the plugin registers.\n`;
}

// ------------------------------------------------- the shipped tree is clean

test("the shipped plugin tree passes the contract validator", () => {
  assert.deepEqual(collectViolations(SHIPPED), [], "scripts/validate.mjs must exit 0 on the shipped tree");
});

// ----------------------------------------------------------- package contents

test("package.json ships the extension, helper, docs, and validator", () => {
  const pkg = JSON.parse(read("package.json"));

  assert.equal(pkg.name, PACKAGE_NAME);
  assert.equal(pkg.version, PACKAGE_VERSION);
  assert.equal(pkg.type, "module");
  assert.equal(pkg.license, "MIT", "the license must be declared");
  assert.deepEqual([...pkg.files].sort(), [...PACKAGE_FILES].sort(), "package.json files must ship the whole plugin");

  for (const entry of PACKAGE_FILES) {
    const rel = entry.replace(/^\.\//, "");
    assert.ok(
      existsSync(join(ROOT, rel)),
      `package.json files entry ${entry} must resolve to a shipped file or directory`,
    );
  }

  for (const artifact of SHIPPED_ARTIFACTS) {
    const covered = pkg.files.some((entry) => {
      const rel = entry.replace(/^\.\//, "").replace(/\/$/, "");
      return artifact === rel || artifact.startsWith(`${rel}/`);
    });
    assert.ok(covered, `package.json files must publish ${artifact}`);
  }

  assert.deepEqual(pkg.omp?.extensions, EXTENSION_ENTRIES, "omp.extensions must point at the extension module");
  assert.ok(
    pkg.files.every((entry) => !entry.replace(/^\.\//, "").startsWith(".omp-plugin")),
    "package.json must not publish a marketplace catalog directory",
  );
});

test("every promised artifact is present in the checkout", () => {
  for (const rel of SHIPPED_ARTIFACTS) {
    assert.ok(existsSync(join(ROOT, rel)), `${rel} must ship`);
  }
  assert.match(read("LICENSE"), /MIT/, "LICENSE must be the declared MIT license");
  assert.ok(read("README.md").trim().length > 0, "README.md must carry the install and usage contract");
});

test("package.json scripts run the validator and the tests without an install step", () => {
  const pkg = JSON.parse(read("package.json"));

  assert.equal(pkg.scripts?.validate, "node scripts/validate.mjs");
  assert.equal(pkg.scripts?.test, "node --test");

  const readme = read("README.md");
  assert.ok(readme.includes("`node scripts/validate.mjs`"), "README.md must document the validator command");
  assert.match(readme, /`node --test`/, "README.md must document the test command as it is scripted");
});

// ------------------------------------------------- marketplace catalog

test("no marketplace catalog ships at any known path", () => {
  for (const rel of CATALOG_FILES) {
    assert.equal(SHIPPED.read(rel), undefined, `${rel} must not ship`);
  }
  assert.deepEqual(SHIPPED.list(".omp-plugin"), [], "the .omp-plugin directory must not ship");
  assert.deepEqual(SHIPPED.list(".claude-plugin"), [], "the .claude-plugin directory must not ship");
  assert.ok(
    !read("package.json").includes(".omp-plugin"),
    "package.json must not assume a marketplace catalog",
  );
});

test("a returning marketplace catalog is rejected until the namespace rewriting is documented", () => {
  for (const rel of CATALOG_FILES) {
    const violations = violationsFor({ [rel]: catalogFixture() });

    expectMessage(violations, "catalog.namespace-docs", rel);
    assert.deepEqual(
      violations.filter((violation) => !violation.startsWith("catalog.namespace-docs")),
      [],
      `only the undocumented return of ${rel} may be wrong:${report(violations)}`,
    );
  }
});

test("namespacing prose outside the section does not license a catalog", () => {
  const readme = `${read("README.md")}\nMarketplace installs are namespaced, so the command names and the MCP server name change.\n`;
  for (const rel of CATALOG_FILES) {
    expectCode(violationsFor({ "README.md": readme, [rel]: catalogFixture() }), "catalog.namespace-docs");
  }
});

test("a documented catalog still has to resolve to this repository", () => {
  const documented = violationsFor({ "README.md": readmeWithNamespaceDocs(), [CATALOG_FILES[0]]: catalogFixture() });
  assert.deepEqual(
    documented.filter((violation) => violation.startsWith("catalog.")),
    [],
    `a documented catalog for this repository must pass the catalog checks:${report(documented)}`,
  );

  for (const rel of CATALOG_FILES) {
    const drifted = violationsFor({
      "README.md": readmeWithNamespaceDocs(),
      [rel]: catalogFixture({ source: "github", repo: "Other/plugin" }),
    });
    expectMessage(drifted, "catalog.plugin-source", rel);
  }
});

test("marketplace install instructions are rejected wherever they appear", () => {
  const readme = `${read("README.md")}\nInstall it with omp plugin install symvanta@symvanta-omp.\n`;
  expectOnly(violationsFor({ "README.md": readme }), "readme.host-ism");

  const command =
    '---\ndescription: Route a lookup.\nargument-hint: "[symbol]"\n---\n\nRun /marketplace add Symvanta/omp-plugin, then look up $ARGUMENTS with relate.\n';
  expectOnly(violationsFor({ "commands/symvanta-blast.md": command }), "command.host-ism");
});

test("a project-scoped install command is rejected: a Git install is user-wide", () => {
  const readme = read("README.md");
  const claimed = `${readme}\n${INSTALL_COMMAND} --scope project\n`;
  assert.notEqual(claimed, readme, "the injection must add the project scope claim");
  expectOnly(violationsFor({ "README.md": claimed }), "readme.host-ism");

  const linked = `${readme}\nomp plugin link /path/to/omp-plugin --scope project\n`;
  assert.notEqual(linked, readme, "the injection must add the link scope claim");
  expectOnly(violationsFor({ "README.md": linked }), "readme.host-ism");
});

// ----------------------------------------------------------- install contract

test("the documented install is the direct Git install, keeping the shipped names", () => {
  const readme = read("README.md");

  assert.ok(readme.includes(INSTALL_COMMAND), `README.md must document ${INSTALL_COMMAND}`);
  assert.ok(readme.includes(UNINSTALL_COMMAND), `README.md must document ${UNINSTALL_COMMAND}`);
  assert.doesNotMatch(readme, /omp plugin marketplace\b/, "README.md must not document a catalog command");
  assert.doesNotMatch(
    readme,
    /\bomp plugin (?:install|uninstall)\s+\S+@\S+/,
    "README.md must not document a catalog-scoped plugin name",
  );
  assert.match(readme, /user-wide/, "a Git install is user-wide and the README must say so");
  assert.doesNotMatch(
    readme,
    /\bomp plugin (?:install|link)\b[^\n]*--scope\s+project/,
    "the installer honors --scope only for marketplace installs, so no project-scoped install may be documented",
  );
  for (const command of COMMANDS) {
    assert.ok(readme.includes(`/${command}`), `README.md must document /${command} as the name a consumer types`);
  }
  assert.equal(JSON.parse(read(".mcp.json")).mcpServers[PLUGIN_NAME].url, MCP_URL, "the server stays `symvanta`");
});

test("README drift for the documented install or uninstall is rejected", () => {
  const readme = read("README.md");

  const noInstall = readme.replaceAll(INSTALL_COMMAND, "omp plugin add symvanta");
  assert.notEqual(noInstall, readme, "README.md must document the direct Git install");
  expectCode(violationsFor({ "README.md": noInstall }), "readme.cli");

  const noUninstall = readme.replaceAll(UNINSTALL_COMMAND, "omp plugin remove symvanta");
  assert.notEqual(noUninstall, readme, "README.md must document the package-name uninstall");
  expectCode(violationsFor({ "README.md": noUninstall }), "readme.cli");
});

// ------------------------------------------------------------------------ mcp

function mcpOverride(server) {
  const config = JSON.parse(read(".mcp.json"));
  return {
    ".mcp.json": JSON.stringify({ ...config, mcpServers: { ...config.mcpServers, [PLUGIN_NAME]: server } }, null, 2),
  };
}

test("a hard-coded MCP URL is rejected: the endpoint must stay env-overridable", () => {
  assert.equal(JSON.parse(read(".mcp.json")).mcpServers[PLUGIN_NAME].url, MCP_URL, "the shipped URL keeps the override");
  expectOnly(
    violationsFor(mcpOverride({ type: "http", url: "https://mcp.symvanta.com/mcp", timeout: MCP_TIMEOUT_MS })),
    "mcp.url",
  );
});

test("a non-default MCP timeout is rejected", () => {
  expectOnly(violationsFor(mcpOverride({ type: "http", url: MCP_URL, timeout: 30000 })), "mcp.timeout");
});

test("a non-http transport is rejected", () => {
  expectCode(violationsFor(mcpOverride({ type: "stdio", url: MCP_URL, timeout: MCP_TIMEOUT_MS })), "mcp.transport");
});

test("a missing Symvanta server entry is rejected", () => {
  expectOnly(violationsFor({ ".mcp.json": JSON.stringify({ mcpServers: {} }) }), "mcp.missing");
});

// ------------------------------------------------------------------- commands

test("a missing or extra command is rejected", () => {
  expectCode(violationsFor({ "commands/symvanta-ask.md": undefined }), "command.set");

  const stray = '---\ndescription: Stray command.\n---\n\nLook up $ARGUMENTS with relate.\n';
  expectCode(violationsFor({ "commands/symvanta-stray.md": stray }), "command.set");
});

test("a command with two aggregate placeholders is rejected", () => {
  const command = '---\ndescription: Doubled placeholder.\n---\n\nFirst $ARGUMENTS then $ARGUMENTS.\n';
  expectOnly(violationsFor({ "commands/symvanta-ask.md": command }), "command.placeholder");
});

// ------------------------------------------------------- host-neutral markdown

test("Claude-only tool prefixes in a command are rejected", () => {
  const command = '---\ndescription: Route a lookup.\nargument-hint: "[symbol]"\n---\n\nLook up $ARGUMENTS with mcp__symvanta__relate.\n';
  expectOnly(violationsFor({ "commands/symvanta-blast.md": command }), "command.host-ism");
});

test("Claude plugin root variables in the skill are rejected", () => {
  const skill = `${read(SKILL_FILE)}\nSet CLAUDE_PLUGIN_ROOT before running the helper.\n`;
  expectOnly(violationsFor({ [SKILL_FILE]: skill }), "skill.host-ism");
});

test("Claude CLI syntax in the README is rejected", () => {
  const readme = `${read("README.md")}\nInstall it first with /plugin install symvanta.\n`;
  expectOnly(violationsFor({ "README.md": readme }), "readme.host-ism");
});

// ----------------------------------------------------------------------- rule

test("a rule that is not always-apply is rejected", () => {
  const rule = read(RULE_FILE);
  assert.ok(rule.includes("alwaysApply: true"), "the shipped rule must be always-apply");
  expectOnly(violationsFor({ [RULE_FILE]: rule.replace("alwaysApply: true", "alwaysApply: false") }), "rule.always-apply");
});

test("a glob-scoped rule that never applies is rejected", () => {
  const rule = read(RULE_FILE).replace("alwaysApply: true", "globs: ['**/*.ts']");
  expectOnly(violationsFor({ [RULE_FILE]: rule }), "rule.always-apply");
});

test("a misspelled always-apply key is rejected instead of silently ignored", () => {
  const rule = read(RULE_FILE).replace("alwaysApply: true", "always_apply: true");
  const violations = violationsFor({ [RULE_FILE]: rule });
  expectCode(violations, "rule.key-unknown");
  expectCode(violations, "rule.always-apply");
});

test("a rule missing a policy requirement is rejected", () => {
  const rule = read(RULE_FILE);
  const broken = rule.replace(/freshness/gi, "index state");
  assert.doesNotMatch(broken, /freshness/i, "the injection must remove every mention of the requirement");
  expectOnly(violationsFor({ [RULE_FILE]: broken }), "rule.requirement");
});

test("a policy that stops routing around local search is rejected", () => {
  const rule = read(RULE_FILE);

  const noOrientation = rule.replace(/\bcontext\b/g, "scan");
  assert.doesNotMatch(noOrientation, /\bcontext\b/, "the injection must remove the orientation tool");
  expectMessage(violationsFor({ [RULE_FILE]: noOrientation }), "rule.requirement", "orientation before search");

  const noFallback = rule.replace(/\bgrep\b/gi, "lookup").replace(/\bglob\b/gi, "lookup");
  assert.doesNotMatch(noFallback, /\b(grep|glob)\b/i, "the injection must remove the local search tools");
  expectMessage(violationsFor({ [RULE_FILE]: noFallback }), "rule.requirement", "local search is not the first move");

  const noRescue = rule.replace(/\blocate\b/g, "find_node");
  assert.doesNotMatch(noRescue, /\blocate\b/, "the injection must remove the empty-search rescue");
  expectMessage(violationsFor({ [RULE_FILE]: noRescue }), "rule.requirement", "empty-search rescue");
});

// -------------------------------------------------------------------- runtime

test("an extension that drops an event registration is rejected", () => {
  const extension = read(EXTENSION_FILE);
  for (const event of ["session_start", "session_switch", "tool_call"]) {
    assert.ok(extension.includes(event), `the extension must register ${event}`);
    const broken = extension.replaceAll(event, event.replace("_", "-"));
    expectCode(violationsFor({ [EXTENSION_FILE]: broken }), "runtime.event");
  }
});

test("an extension that drops a runtime token is rejected", () => {
  const extension = read(EXTENSION_FILE);
  for (const token of ["blast_radius", "estimate_scope", "SYMVANTA_ENFORCE_IMPACT"]) {
    assert.ok(extension.includes(token), `the extension must reference ${token}`);
    const broken = extension.replaceAll(token, "impact");
    expectCode(violationsFor({ [EXTENSION_FILE]: broken }), "runtime.token");
  }
});

test("an extension that drops the namespaced-tool or apply_patch read is rejected", () => {
  const extension = read(EXTENSION_FILE);

  const noNamespace = extension.replaceAll("SYMVANTA_NAMESPACE", "SYMVANTA_PREFIX");
  assert.notEqual(noNamespace, extension, "the extension must read a namespaced wire name");
  expectCode(violationsFor({ [EXTENSION_FILE]: noNamespace }), "runtime.contract");

  const noPatchHeaders = extension.replaceAll("APPLY_PATCH_HEADER", "PATCH_MARKER");
  assert.notEqual(noPatchHeaders, extension, "the extension must read apply_patch file markers");
  expectCode(violationsFor({ [EXTENSION_FILE]: noPatchHeaders }), "runtime.contract");

  const noQuotes = extension.replaceAll("QUOTED_PATH", "RAW_PATH");
  assert.notEqual(noQuotes, extension, "the extension must unquote a path it was handed");
  expectCode(violationsFor({ [EXTENSION_FILE]: noQuotes }), "runtime.contract");
});

test("a missing extension or helper file is rejected", () => {
  const missingExtension = violationsFor({ [EXTENSION_FILE]: undefined });
  expectCode(missingExtension, "runtime.missing");
  expectCode(missingExtension, "package.extensions-path");

  expectCode(violationsFor({ [REPOSITORY_MODULE]: undefined }), "runtime.missing");
});

test("a helper that stops being pure is rejected", () => {
  const module = read(REPOSITORY_MODULE);
  const impure = `import { readFileSync } from "node:fs";\n${module}\nconst token = process.env.SYMVANTA_MCP_TOKEN;\n`;
  expectCode(violationsFor({ [REPOSITORY_MODULE]: impure }), "runtime.module-purity");
});

test("a direct HTTP client or credential read in the extension is rejected", () => {
  const extension = read(EXTENSION_FILE);
  const breakages = [
    ["direct HTTP client", `${extension}\nimport * as https from "node:https";\n`],
    ["credential file read", `${extension}\nconst raw = readFileSync(".credentials.json");\n`],
    ["OAuth credential-store access", `${extension}\nconst store = "mcp_oauth";\n`],
  ];

  for (const [label, broken] of breakages) {
    const violations = violationsFor({ [EXTENSION_FILE]: broken });
    assert.ok(
      codesOf(violations).includes("runtime.direct-access"),
      `${label} must be rejected, got:${report(violations)}`,
    );
  }
});

// --------------------------------------------------------------------- readme

test("README drift for any shipped command is rejected", () => {
  const readme = read("README.md");
  for (const command of COMMANDS) {
    const drifted = readme.replaceAll(`/${command}`, command);
    assert.notEqual(drifted, readme, `README.md must document /${command}`);
    expectCode(violationsFor({ "README.md": drifted }), "readme.command");
  }
});

test("README drift for a CLI snippet or section is rejected", () => {
  const readme = read("README.md");

  const noLink = readme.replaceAll("omp plugin link", "omp plugin attach");
  assert.notEqual(noLink, readme, "README.md must document omp plugin link");
  expectCode(violationsFor({ "README.md": noLink }), "readme.cli");

  const noPrivacy = readme.replace("## Privacy", "## Data handling");
  assert.notEqual(noPrivacy, readme, "README.md must have a Privacy section");
  expectOnly(violationsFor({ "README.md": noPrivacy }), "readme.section");

  const noTitle = readme.replace(/^# .*$/m, "Symvanta plugin");
  assert.notEqual(noTitle, readme, "README.md must have an H1 title");
  expectCode(violationsFor({ "README.md": noTitle }), "readme.heading");
});

test("a missing README is rejected", () => {
  expectCode(violationsFor({ "README.md": undefined }), "readme.missing");
});

test("README still documents OAuth, reload, privacy, and the hook rationale", () => {
  const readme = read("README.md");
  const required = [
    ["OAuth sign-in", /\bOAuth\b/],
    ["plugin reload", /\/reload-plugins/],
    ["privacy statement", /^## Privacy\b/m],
    ["hook rationale", /hook/i],
  ];

  for (const [label, pattern] of required) {
    assert.match(readme, pattern, `README.md must document ${label}`);
  }

  const noHooks = readme.replace(/hooks?/gi, "extensions");
  assert.notEqual(noHooks, readme, "README.md must document the hook rationale");
  expectCode(violationsFor({ "README.md": noHooks }), "readme.cli");
});

test("the README does not claim the status command reports hidden gate state", () => {
  const readme = read("README.md");
  const row = readme.split("\n").find((line) => line.includes("/symvanta-status"));
  assert.ok(row, "README.md must document /symvanta-status");

  assert.doesNotMatch(row, /gate state/i, "the gate lives in the extension process, not in the graph");
  assert.match(row, /in-process/i, "the row must say where the gate state lives");

  const status = read("commands/symvanta-status.md");
  assert.doesNotMatch(status, /printenv/, "the command must not shell out to read the gate");
  assert.doesNotMatch(status, /already ran|disarmed/i, "the command cannot see whether the gate fired");
});

// ---------------------------------------------------------- package file list

test("a package.json files entry that ships nothing is rejected", () => {
  const pkg = JSON.parse(read("package.json"));
  const drifted = { ...pkg, files: [...pkg.files, "docs/missing.md"] };
  expectCode(violationsFor({ "package.json": JSON.stringify(drifted, null, 2) }), "package.files-path");
});

test("an omp.extensions entry that does not exist is rejected", () => {
  const pkg = JSON.parse(read("package.json"));
  const drifted = { ...pkg, omp: { ...pkg.omp, extensions: ["./src/missing.ts"] } };
  const violations = violationsFor({ "package.json": JSON.stringify(drifted, null, 2) });
  expectCode(violations, "package.extensions");
  expectCode(violations, "package.extensions-path");
});

// ------------------------------------------------- hook static contract

test("no Claude Code hooks.json ships: OMP wires hooks as extension events", () => {
  assert.equal(SHIPPED.read("hooks/hooks.json"), undefined, "the plugin must not ship a Claude hooks.json");
  assert.equal(SHIPPED.read("hooks.json"), undefined, "the plugin must not ship a Claude hooks.json at the root");

  expectOnly(violationsFor({ "hooks/hooks.json": JSON.stringify({ hooks: { PreToolUse: [] } }) }), "hooks.claude-json");
});

test("the extension registers in-process events instead of spawning hook processes", () => {
  const code = stripComments(read(EXTENSION_FILE));

  for (const event of ["session_start", "session_switch", "tool_call", "tool_result", "session_shutdown"]) {
    assert.match(code, new RegExp(`["'\`]${event}["'\`]`), `${EXTENSION_FILE} must register ${event}`);
  }

  assert.doesNotMatch(code, /process\.stdin/, "the extension must not parse a hook envelope from stdin");
  assert.doesNotMatch(code, /CLAUDE_PLUGIN_ROOT/, "the extension must not read a Claude plugin root");
  assert.doesNotMatch(code, /\bhooks?\//, "the extension must not shell out to hook scripts");
});

test("a new session switch re-queues the primer through the session-start routine", () => {
  const code = stripComments(read(EXTENSION_FILE));

  const initialize = functionBody(code, "initializeSession");
  assert.match(initialize, /resetSessionState/, "a fresh transcript must not inherit the previous gate");
  assert.match(initialize, /queueRepositoryPrimer/, "a fresh transcript must be re-primed");

  const primer = functionBody(code, "queueRepositoryPrimer");
  assert.match(primer, /buildStartupContext/, "the primer is the same startup context session_start sends");
  assert.match(primer, /display: false/, "the primer stays hidden from the transcript");
  assert.match(primer, /deliverAs: "nextTurn"/, "the primer must not start a turn of its own");

  for (const event of ["session_start", "session_switch"]) {
    assert.match(
      handlerBody(code, event),
      /initializeSession/,
      `${event} must go through the shared fresh-session routine`,
    );
  }

  const switched = handlerBody(code, "session_switch");
  assert.match(switched, /isNewSessionSwitch/, "only a new session may re-issue the primer");
  assert.match(switched, /return;/, "a resume, fork, or plain switch must do nothing");

  const isNew = functionBody(code, "isNewSessionSwitch");
  assert.match(isNew, /reason/, "the switch reason decides whether a transcript is new");
  assert.match(isNew, /"new"/, "`/new` is the reason that starts an empty transcript");
  assert.match(isNew, /toLowerCase\(\)/, "the reason is compared without case sensitivity");
});

test("the extension keys pending impact calls by toolCallId and promotes only on a successful result", () => {
  const code = stripComments(read(EXTENSION_FILE));

  assert.match(code, /toolCallId/, "impact calls must be identified per tool call");
  assert.match(code, /pendingImpact/, "pending impact calls must be tracked until their result arrives");
  assert.match(code, /new Set/, "pending impact calls are a set of call ids");
  assert.match(code, /pendingImpact\.add\(/, "a scheduled impact call must be recorded as pending");
  assert.match(code, /pendingImpact\.delete\(/, "a settled impact call must leave the pending set");

  // Every entry point into a fresh transcript resets the guard through the same
  // routine, so a stale call id from the previous transcript cannot be matched.
  const reset = functionBody(code, "resetSessionState");
  assert.match(reset, /pendingImpact\.clear\(\)/, "a fresh session must drop pending impact state");
  assert.match(reset, /impactObserved = false/, "a fresh session must start unsatisfied");
  assert.match(
    handlerBody(code, "session_shutdown"),
    /pendingImpact\.clear\(\)/,
    "shutdown must drop pending impact state",
  );

  const call = handlerBody(code, "tool_call");
  assert.match(call, /pendingImpact\.add\(/, "the impact call must be recorded when it is scheduled");
  assert.doesNotMatch(
    call,
    /impactObserved\s*=\s*true/,
    "a scheduled impact call must not satisfy the gate: the edit may run before it returns",
  );

  const gate = call.split("\n").find((line) => line.includes("MAX_GUARD_BLOCKS"));
  assert.ok(gate, "the edit gate must stay capped by MAX_GUARD_BLOCKS");
  assert.match(gate, /impactObserved/, "the gate must consult the satisfied flag");
  assert.doesNotMatch(gate, /pendingImpact/, "a pending call must not open the gate");

  const result = handlerBody(code, "tool_result");
  assert.match(result, /impactObserved\s*=\s*true/, "only a tool result may satisfy the gate");
  assert.match(result, /isError/, "a failed result must be recognised");
  assert.match(result, /\berror\b/, "an error payload must be recognised");
});

test("the gate reads edit targets from every wire shape the host can send", () => {
  const code = stripComments(read(EXTENSION_FILE));
  const targets = functionBody(code, "editTargets");

  const raw = /typeof input === "string"/.exec(targets);
  assert.ok(raw, "a raw freeform payload must be read as a string, not dropped");
  assert.match(
    targets.slice(raw.index, raw.index + 80),
    /payloadTargets/,
    "a raw freeform payload must be parsed for its file headers",
  );

  const fields = /const PATH_FIELDS = \[([\s\S]*?)\]/.exec(code);
  assert.ok(fields, "the field form must read an explicit list of target fields");
  for (const field of ["path", "file_path", "filePath"]) {
    assert.match(fields[1], new RegExp(`"${field}"`), `${field} must name an edit target`);
  }

  assert.match(targets, /PATH_FIELDS/, "the field form must come from the declared field list");
  assert.match(targets, /Array\.isArray\(input\)/, "the whole input may be an array of mutations");
  assert.match(targets, /Array\.isArray\(value\)/, "a target field may carry an array of paths");
  assert.match(targets, /record\.input/, "the object form must still descend into its nested payload");
  assert.match(targets, /payloadTargets/, "patch headers are how a payload names its files");
  assert.match(targets, /MAX_TARGET_DEPTH/, "a bridged payload must be bounded, not recursed forever");

  assert.match(functionBody(code, "gatedTarget"), /normalizeTarget/, "every target must be unquoted before it resolves");
});

test("Symvanta tool names are recognized through a namespace, not a fixed prefix", () => {
  const code = stripComments(read(EXTENSION_FILE));

  const namespace = extensionLiteral("SYMVANTA_NAMESPACE");
  const wires = [
    "mcp__symvanta_relate",
    "mcp__symvanta__relate",
    "mcp__symvanta_symvanta_relate",
    "mcp__symvanta_symvanta_estimate_scope",
    "symvanta_relate",
    "symvanta:relate",
  ];
  for (const wire of wires) {
    assert.ok(matcher(namespace).test(wire), `${wire} must be read as a Symvanta wire name`);
  }
  for (const foreign of ["mcp__github_relate", "mcp__notsymvanta_relate", "relate"]) {
    assert.ok(!matcher(namespace).test(foreign), `${foreign} must not be read as a Symvanta wire name`);
  }

  const table = /const SYMVANTA_TOOLS: Record<string, true> = \{([\s\S]*?)\n\};/.exec(code);
  assert.ok(table, "the bare name must be validated against the tools Symvanta serves");
  for (const tool of ["relate", "estimate_scope", "context", "locate"]) {
    assert.match(table[1], new RegExp(`\\b${tool}: true`), `${tool} must be in the known-tool table`);
  }

  const resolver = functionBody(code, "namespacedToolName");
  assert.match(resolver, /SYMVANTA_NAMESPACE/, "the namespace run is the anchor for the bare name");
  assert.match(resolver, /SYMVANTA_TOOLS/, "the tail only counts when the table names it");

  const named = functionBody(code, "symvantaToolName");
  assert.match(named, /mcpServerName/, "a definition that names the server settles the question first");
  assert.match(named, /namespacedToolName/, "a wire name still falls back to the namespace read");

  assert.match(functionBody(code, "isImpactCheckCall"), /symvantaToolName/, "the impact check must use that read");
});

test("the gate reads both patch dialects and unquotes the paths they name", () => {
  const code = stripComments(read(EXTENSION_FILE));

  const applyPatch = extensionLiteral("APPLY_PATCH_HEADER");
  const hashline = extensionLiteral("HASHLINE_HEADER");
  const quoted = extensionLiteral("QUOTED_PATH");
  const copied = extensionLiteral("COPIED_HEADER");

  const headers = [
    [applyPatch, "*** Update File: src/a.ts", "src/a.ts"],
    [applyPatch, "*** Delete File: src/b.ts", "src/b.ts"],
    [applyPatch, "*** Add File: src/c.ts", "src/c.ts"],
    [hashline, "[src/d.ts#1A2B]", "src/d.ts"],
  ];
  for (const [literal, line, expected] of headers) {
    const match = matcher(literal).exec(`${line}\n`);
    assert.ok(match, `${JSON.stringify(line)} must be read as a file header`);
    assert.equal(match[1], expected, `${JSON.stringify(line)} must name ${expected}`);
  }

  for (const [line, expected] of [
    ['"src/e.ts"', "src/e.ts"],
    ["'src/f.ts'", "src/f.ts"],
  ]) {
    const match = matcher(quoted).exec(line);
    assert.ok(match, `${line} must be read as a quoted path`);
    assert.equal(match[2], expected, `${line} must unquote to ${expected}`);
  }
  assert.equal(matcher(quoted).exec("src/g.ts"), null, "an unquoted path must not be treated as quoted");

  const copiedMatch = matcher(copied).exec("[src/h.ts#1A2B]");
  assert.ok(copiedMatch, "a path still wrapped in a copied [path#TAG] header must be recognized");
  assert.equal(copiedMatch[1], "src/h.ts", "the copied header must yield the path inside it");

  const payload = functionBody(code, "payloadTargets");
  assert.match(payload, /headerPaths/, "every dialect must go through the shared header reader");
  for (const dialect of ["HASHLINE_HEADER", "APPLY_PATCH_HEADER"]) {
    assert.match(payload, new RegExp(dialect), `${dialect} must be one of the dialects the payload reader reads`);
  }
  for (const dialect of ["SLOPPY_HEADER", "SLOPPY_TAG_HEADER"]) {
    assert.match(payload, new RegExp(dialect), `${dialect} must be one of the dialects the payload reader reads`);
  }

  const sloppy = extensionLiteral("SLOPPY_HEADER");
  const sloppyHeader = matcher(sloppy).exec("*** SM:EDIT src/i.ts\n");
  assert.ok(sloppyHeader, "a sloppy `*** SM:EDIT <path>` section must name its file");
  assert.equal(sloppyHeader[1].trim(), "src/i.ts", "the sloppy header must yield the path after the marker");

  const sloppyTag = extensionLiteral("SLOPPY_TAG_HEADER");
  const tag = matcher(sloppyTag).exec('<SM:EDIT path="src/j.ts">\n');
  assert.ok(tag, "a sloppy `<SM:EDIT ...>` tag must name its file");
  assert.equal(tag[1].trim(), 'path="src/j.ts"', "the tag must yield its attributes for the path attribute read");

  const tagPath = extensionLiteral("SLOPPY_TAG_PATH");
  assert.equal(matcher(tagPath).exec('path="src/j.ts"')[1], "src/j.ts", "a double-quoted path attribute must be read");
  assert.equal(matcher(tagPath).exec("path='src/k.ts'")[2], "src/k.ts", "a single-quoted path attribute must be read");
  assert.equal(matcher(tagPath).exec("path=src/l.ts")[3], "src/l.ts", "a bare path attribute must be read");

  const normalize = functionBody(code, "normalizeTarget");
  assert.match(normalize, /COPIED_HEADER/, "a copied header must be unwrapped");
  assert.match(normalize, /QUOTED_PATH/, "surrounding quotes must be stripped");

  const gate = functionBody(code, "gatedTarget");
  assert.match(
    gate,
    /normalizeAlias\(normalizeTarget\(/,
    "an aliased target must be normalized before it resolves",
  );
  assert.match(gate, /=== null/, "a target that names no local file must be skipped, not guessed at");
});

test("path aliases and sloppy file attributes resolve to the local target", () => {
  const code = stripComments(read(EXTENSION_FILE));

  const alias = functionBody(code, "normalizeAlias");
  assert.match(alias, /startsWith\(":"\)/, "the `:/absolute` alias must be stripped");
  assert.match(alias, /startsWith\("@"\)/, "the `@/absolute` and `@~/` aliases must be stripped");
  assert.match(alias, /decodeURIComponent/, "a `file:///` target must be percent-decoded into a path");
  assert.match(alias, /homedir\(\)/, "`~`, `~/x`, and `~x` must expand to the platform home");
  assert.match(alias, /return null/, "a foreign scheme names no local file and must be dropped");

  const fileUrl = extensionLiteral("FILE_URL");
  assert.ok(matcher(fileUrl).test("file:///home/user/a.ts"), "a file URL must be recognized");
  assert.ok(!matcher(fileUrl).test("src/a.ts"), "a relative path is not a file URL");

  const scheme = extensionLiteral("URL_SCHEME");
  assert.ok(matcher(scheme).test("https://example.com/a.ts"), "a URL scheme must be recognized");
  assert.ok(!matcher(scheme).test("src/a.ts"), "a relative path carries no scheme");

  const drive = extensionLiteral("WINDOWS_DRIVE");
  assert.ok(matcher(drive).test("C:\\src\\a.ts"), "a Windows drive path must not read as a scheme");
  assert.ok(matcher(drive).test("C:/src/a.ts"), "a Windows drive path with forward slashes must be recognized");

  const spaces = extensionLiteral("UNICODE_SPACES");
  assert.ok(matcher(spaces).test("src\u00a0a.ts"), "a non-breaking space in a path must be normalized");

  const copied = extensionLiteral("COPIED_HEADER");
  const bare = matcher(copied).exec("[src/m.ts]");
  assert.ok(bare, "a bare bracketed [path] target must be unwrapped");
  assert.equal(bare[1], "src/m.ts", "the bracketed target must yield the path inside it");
  const tagged = matcher(copied).exec("[src/n.ts#1A2B]");
  assert.ok(tagged, "a bracketed [path#TAG] target must be unwrapped");
  assert.equal(tagged[1], "src/n.ts", "the tagged target must yield the path inside it");

  const tagPath = extensionLiteral("SLOPPY_TAG_PATH");
  assert.equal(matcher(tagPath).exec('file="src/o.ts"')[1], "src/o.ts", "a sloppy `file=` attribute must be read");
  assert.equal(matcher(tagPath).exec("file=src/p.ts")[3], "src/p.ts", "a bare sloppy `file=` value must be read");
});

test("the extension never speaks HTTP itself and never reads credentials", () => {
  const code = stripComments(read(EXTENSION_FILE));
  const module = stripComments(read(REPOSITORY_MODULE));

  const forbidden = [
    ["direct HTTP client", /node:https?/],
    ["direct fetch call", /\bfetch\s*\(/],
    ["HTTP client dependency", /require\(\s*["'](?:axios|node-fetch|undici|got)["']\s*\)|from\s+["'](?:axios|node-fetch|undici|got)["']/],
    ["credential file read", /credentials\.json/],
    ["OAuth credential-store access", /mcp_oauth/],
    ["Claude credential store", /(?:\.claude|\.credentials)\//],
  ];

  for (const [label, pattern] of forbidden) {
    assert.doesNotMatch(code, pattern, `${EXTENSION_FILE} must not perform a ${label}`);
    assert.doesNotMatch(module, pattern, `${REPOSITORY_MODULE} must not perform a ${label}`);
  }

  for (const [, name] of code.matchAll(/process\.env\.([A-Za-z0-9_]+)/g)) {
    assert.equal(name, "SYMVANTA_ENFORCE_IMPACT", `${EXTENSION_FILE} must not read credential-bearing env vars`);
  }

  assert.doesNotMatch(module, /\bimport\b|\brequire\s*\(|process\.env|node:/, "the helper must stay dependency-free");
});
