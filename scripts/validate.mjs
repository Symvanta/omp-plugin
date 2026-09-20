#!/usr/bin/env node
// Contract validator for the Symvanta OMP plugin.
//
// Dependency-free by design: Node built-ins only, no install step, so it can run
// as a release gate anywhere Node runs.
//
// Check codes (every violation is reported as "<code>: <message>"):
//   package.*   package.json manifest: name, version, type, omp.extensions, declared paths
//   catalog.*   marketplace catalog: absent from this release at every known path
//               (.omp-plugin/, .claude-plugin/, repo root), and rejected when it
//               returns without the namespace rewriting documented in README.md
//   mcp.*       Symvanta MCP server definition: transport, URL default/override, timeout
//   rule.*      rules/*.md frontmatter and the always-apply policy requirements
//   command.*   commands/symvanta-*.md names, frontmatter, argument placeholder, host-neutral tools
//   skill.*     skills/symvanta/SKILL.md presence and frontmatter
//   runtime.*   src/index.ts static behavior: session_start/session_switch context, pre-edit
//               impact gate, defensive tool-name resolution, no credential reads, no direct HTTP
//   readme.*    README documents the direct Git install, the package-name uninstall, OAuth,
//               reload, privacy, and the hook rationale
//   host.*      no Claude-only or marketplace-only reference in a shipped artifact
//   hooks.*     no Claude Code hooks.json (OMP wires hooks as extension events)
//
// Usage: node scripts/validate.mjs
// Exit:  0 clean, 1 with a report of every violation found.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- expectations

export const PLUGIN_NAME = 'symvanta';
export const PACKAGE_NAME = '@symvanta/omp-plugin';
export const PACKAGE_VERSION = '0.1.0';
export const EXTENSION_ENTRIES = ['./src/index.ts'];
export const REPOSITORY = 'Symvanta/omp-plugin';
export const MCP_URL = '${SYMVANTA_MCP_URL:-https://mcp.symvanta.com/mcp}';
export const MCP_TIMEOUT_MS = 120000;

/** The documented install: this repository, so the names below stay the names a consumer types. */
export const INSTALL_COMMAND = `omp plugin install github:${REPOSITORY}`;

/** Uninstall goes by package name for both install paths. */
export const UNINSTALL_COMMAND = `omp plugin uninstall ${PACKAGE_NAME}`;

export const COMMANDS = [
  'symvanta-ask',
  'symvanta-architecture',
  'symvanta-blast',
  'symvanta-scope',
  'symvanta-status',
  'symvanta-tests',
  'symvanta-trace',
  'symvanta-working-tree',
];

const CATALOG_FILES = ['.omp-plugin/marketplace.json', '.claude-plugin/marketplace.json', 'marketplace.json'];
const RULE_FILE = 'rules/symvanta.md';
const SKILL_FILE = 'skills/symvanta/SKILL.md';
const EXTENSION_FILE = 'src/index.ts';
const REPOSITORY_MODULE = 'src/repository.js';

// Frontmatter keys the rule loader understands (buildRuleFromMarkdown). An
// unknown key is silently ignored at runtime, which is exactly how a typo like
// `always_apply` turns an always-apply rule into a rule that never applies.
const RULE_KEYS = new Set([
  'name',
  'description',
  'globs',
  'alwaysApply',
  'condition',
  'astCondition',
  'scope',
  'agents',
  'interruptMode',
  'ttsr_trigger',
]);

// The always-apply policy must state each of these, or it is not the policy the
// plugin promises. Token-level, not prose-level: the point is that the rule names
// the mechanism.
const RULE_REQUIREMENTS = [
  ['init binding', /\binit\b/],
  ['graph-first lookup', /\b(relate|find_node|locate|quick_lookup|ask_codebase|map)\b/],
  ['orientation before search', /\bcontext\b/],
  ['local search is not the first move', /\b(grep|glob)\b/i],
  ['empty-search rescue', /\blocate\b/],
  ['pre-edit blast radius', /blast[_ ]?radius/i],
  ['local read after graph', /\bRead\b/],
  ['lsp for references and refactors', /\blsp\b/i],
  ['freshness after pushes', /\bfreshness\b/i],
  ['indexed-workspace check', /attached/i],
];

const EXPECTED_EVENTS = ['session_start', 'session_switch', 'tool_call'];
const EXPECTED_RUNTIME_TOKENS = ['blast_radius', 'estimate_scope', 'SYMVANTA_ENFORCE_IMPACT'];

// Behaviors the extension cannot prove by running here: the module is TypeScript
// loaded by OMP, so each one is pinned to the code identifier that carries it.
// The namespace read and the known-tool table are what let a rewritten install's
// wire name still resolve to a bare Symvanta tool; the patch constants are how a
// payload names its files, including the sloppy `path=`/`file=` attribute; and
// the alias step is what turns a `file:///`, `@/`, `@~/`, `:/`, or `[path]`
// target into the local path the guard can stat, while a foreign scheme names no
// local file at all.
const EXPECTED_RUNTIME_PATTERNS = [
  ['namespaced tool-name fallback', /\bSYMVANTA_NAMESPACE\b/],
  ['known Symvanta tool table', /\bSYMVANTA_TOOLS\b/],
  ['apply_patch section headers', /\bAPPLY_PATCH_HEADER\b/],
  ['quoted path stripping', /\bQUOTED_PATH\b/],
  ['path-alias normalization', /\bnormalizeAlias\b/],
  ['file URL alias', /\bFILE_URL\b/],
  ['non-file scheme rejection', /\bURL_SCHEME\b/],
  ['sloppy path/file attribute', /\bSLOPPY_TAG_PATH\b/],
  ['home directory expansion', /\bhomedir\b/],
];

// Code-side markers of the Claude Code hook shape: reading a credential file, or
// opening the MCP endpoint directly. The OMP plugin must do neither. Comments are
// stripped before this scan, so a comment may name them freely.
const FORBIDDEN_RUNTIME_PATTERNS = [
  ['credential file read', /credentials\.json/],
  ['OAuth credential-store access', /mcp_oauth/],
  ['direct HTTP client', /node:https?/],
];

const CLAUDE_ISM_PATTERNS = [
  ['Claude plugin root variable', /CLAUDE_PLUGIN_ROOT/],
  ['Claude hook event name', /\b(PreToolUse|PostToolUse|UserPromptSubmit)\b/],
  ['Claude CLI syntax', /\/plugin (?:install|marketplace|update|uninstall)\b/],
];

// A command or skill calls a Symvanta tool by its bare name, so `mcp__` there is
// the Claude Code way of spelling it. The README is allowed to name a wire shape
// while documenting how a namespaced install is still recognized.
const CLAUDE_TOOL_PREFIX = ['Claude MCP tool prefix', /mcp__/];

// Defects a shipped artifact may not document:
//   - a marketplace install, which is not part of this release (a catalog entry
//     hands the plugin's commands and MCP server to OMP's namespace rewriting,
//     so a consumer would get names this plugin does not register);
//   - an install-scope claim: the installer honors `--scope` only for marketplace
//     installs (`name@marketplace`), so a Git install is user-wide and a
//     project-scoped install command is wrong.
const ARTIFACT_PATTERNS = [
  ['marketplace catalog command', /\bomp plugin marketplace\b/],
  ['in-session marketplace command', /(?:^|\s)\/marketplace\b/],
  ['catalog-scoped plugin name', /\bomp plugin (?:install|uninstall)\s+\S+@\S+/],
  ['project-scoped install command', /\bomp plugin (?:install|link)\b[^\n]*--scope\s+project/],
];

const COMMAND_ISM_PATTERNS = [...CLAUDE_ISM_PATTERNS, CLAUDE_TOOL_PREFIX, ...ARTIFACT_PATTERNS];
const README_ISM_PATTERNS = [...CLAUDE_ISM_PATTERNS, ...ARTIFACT_PATTERNS];

// The documented install and uninstall, bound to the manifest identity above so
// the README cannot drift into a name the installer resolves differently.
const README_CLI_SNIPPETS = [
  ['direct Git install', INSTALL_COMMAND],
  ['local link', 'omp plugin link'],
  ['package-name uninstall', UNINSTALL_COMMAND],
  ['registered plugin list', 'omp plugin list'],
  ['plugin reload', '/reload-plugins'],
  ['OAuth reauth', '/mcp reauth symvanta'],
  ['OAuth credential removal', '/mcp unauth symvanta'],
  ['MCP URL override', 'SYMVANTA_MCP_URL'],
  ['Cloud default URL', 'https://mcp.symvanta.com/mcp'],
  ['impact gate switch', 'SYMVANTA_ENFORCE_IMPACT'],
  ['validator command', 'node scripts/validate.mjs'],
  ['hook rationale', 'Why the Claude Code hook family is not copied'],
];

const README_SECTIONS = ['Install', 'Commands', 'Privacy', 'Uninstall'];

// A marketplace catalog may only return together with the namespacing contract
// documented: this section, stating what OMP rewrites. The check is section-scoped
// so prose elsewhere in the README cannot satisfy it by accident.
const MARKETPLACE_DOC_HEADING = '## Marketplace namespacing';
const MARKETPLACE_DOC_REQUIREMENTS = [
  ['namespacing mechanism', /namespac\w*/i],
  ['command names', /\bcommands?\b/],
  ['MCP server name', /\bserver\b/],
];

// ------------------------------------------------------------------- project io

/**
 * A project is a read/list view over a plugin tree. `withOverrides` layers
 * in-memory content over it so tests can break exactly one file.
 */
export function projectFromDisk(root) {
  return {
    root,
    read(rel) {
      try {
        return readFileSync(join(root, rel), 'utf8');
      } catch {
        return undefined;
      }
    },
    list(dir) {
      try {
        return readdirSync(join(root, dir), { withFileTypes: true })
          .filter((entry) => entry.isFile() || entry.isSymbolicLink() || entry.isDirectory())
          .map((entry) => entry.name)
          .filter((name) => !name.startsWith('.'))
          .sort();
      } catch {
        return [];
      }
    },
  };
}

export function withOverrides(project, overrides) {
  const layered = new Map(Object.entries(overrides));
  return {
    root: project.root,
    read(rel) {
      return layered.has(rel) ? layered.get(rel) : project.read(rel);
    },
    list(dir) {
      const extra = [...layered.entries()]
        .filter(([rel, content]) => content !== undefined && rel.startsWith(`${dir}/`))
        .map(([rel]) => rel.slice(dir.length + 1))
        .filter((name) => !name.includes('/'));
      return [...new Set([...project.list(dir), ...extra])]
        .filter((name) => {
          const key = `${dir}/${name}`;
          return !layered.has(key) || layered.get(key) !== undefined;
        })
        .sort();
    },
  };
}

export function projectRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

// ---------------------------------------------------------------------- helpers

function fail(violations, code, message) {
  violations.push(`${code}: ${message}`);
}

function readJson(project, rel, violations, code) {
  const text = project.read(rel);
  if (text === undefined) {
    fail(violations, code, `${rel} is missing`);
    return undefined;
  }
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      fail(violations, code, `${rel} must contain a JSON object`);
      return undefined;
    }
    return value;
  } catch (error) {
    fail(violations, code, `${rel} is not valid JSON (${error.message})`);
    return undefined;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function parseScalar(raw) {
  const value = raw.trim();
  if (value === '') return '';
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((part) => part.trim().replace(/^["']|["']$/g, ''))
      .filter((part) => part !== '');
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

/** Minimal frontmatter reader: `---` block of `key: value` lines, then the body. */
export function parseFrontmatter(text) {
  if (typeof text !== 'string') return { error: 'no content' };
  if (!text.startsWith('---')) return { error: 'file must start with a --- frontmatter block' };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { error: 'unterminated frontmatter block' };
  const data = {};
  for (const line of text.slice(3, end).split('\n')) {
    if (line.trim() === '') continue;
    const match = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (!match) return { error: `unparsable frontmatter line: ${line.trim()}` };
    data[match[1]] = parseScalar(match[2]);
  }
  return { data, body: text.slice(end + 4) };
}

function stripCodeComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

function markdownFiles(project, dir) {
  return project.list(dir).filter((name) => name.endsWith('.md'));
}

/**
 * Markdown an OMP consumer reads must not name a foreign host's wiring (Claude
 * Code) or a marketplace install this release does not ship.
 */
function checkHostArtifacts(text, rel, violations, code, patterns) {
  for (const [label, pattern] of patterns) {
    if (pattern.test(text)) fail(violations, code, `${rel} contains a ${label}`);
  }
}

// ---------------------------------------------------------------------- package

function checkPackage(project, violations) {
  const pkg = readJson(project, 'package.json', violations, 'package.json-invalid');
  if (pkg === undefined) return undefined;

  if (pkg.name !== PACKAGE_NAME) {
    fail(violations, 'package.name', `package.json name must be ${PACKAGE_NAME}, found ${JSON.stringify(pkg.name)}`);
  }
  if (pkg.version !== PACKAGE_VERSION) {
    fail(violations, 'package.version', `package.json version must be ${PACKAGE_VERSION}, found ${JSON.stringify(pkg.version)}`);
  }
  if (pkg.type !== 'module') {
    fail(violations, 'package.type', 'package.json type must be "module"');
  }
  if (!nonEmptyString(pkg.description)) {
    fail(violations, 'package.description', 'package.json needs a non-empty description');
  }

  const manifest = pkg.omp ?? pkg.pi;
  const entries = manifest?.extensions;
  if (!Array.isArray(entries) || entries.length === 0) {
    fail(violations, 'package.extensions', 'package.json omp.extensions must be a non-empty array');
  } else {
    const actual = [...entries].sort();
    const expected = [...EXTENSION_ENTRIES].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      fail(
        violations,
        'package.extensions',
        `package.json omp.extensions must be ${JSON.stringify(EXTENSION_ENTRIES)}, found ${JSON.stringify(entries)}`,
      );
    }
    for (const entry of entries) {
      if (typeof entry !== 'string' || project.read(entry.replace(/^\.\//, '')) === undefined) {
        fail(violations, 'package.extensions-path', `omp.extensions entry ${JSON.stringify(entry)} does not exist`);
      }
    }
  }

  if (pkg.type === 'module') {
    const src = project.read(EXTENSION_FILE);
    if (src === undefined) {
      fail(violations, 'package.extensions-path', `${EXTENSION_FILE} is missing`);
    } else if (!/\bexport\s+default\b/.test(src)) {
      fail(violations, 'runtime.entry', `${EXTENSION_FILE} must default-export the extension factory`);
    }
  }

  if (pkg.files !== undefined) {
    if (!Array.isArray(pkg.files)) {
      fail(violations, 'package.files', 'package.json files must be an array of paths');
    } else {
      for (const entry of pkg.files) {
        if (typeof entry !== 'string' || !pathExists(project, entry)) {
          fail(violations, 'package.files-path', `package.json files entry ${JSON.stringify(entry)} does not exist`);
        }
      }
    }
  }

  return pkg;
}

/** True when the path is a file we can read or a directory we can list. */
function pathExists(project, rel) {
  const clean = rel.replace(/^\.\//, '').replace(/\/$/, '');
  if (project.read(clean) !== undefined) return true;
  return project.list(clean).length > 0;
}

// ---------------------------------------------------------------------- catalog

const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

function validName(value, max) {
  return typeof value === 'string' && value.length <= max && NAME_PATTERN.test(value);
}

/** Body of one `## <heading>` section, or undefined when that heading is absent. */
function sectionBody(text, heading) {
  const lines = typeof text === 'string' ? text.split('\n') : [];
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^## /.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/**
 * This release ships no marketplace catalog, on purpose: a marketplace install
 * hands the plugin's commands and MCP server to OMP's namespace rewriting, so a
 * consumer would get names this README does not document. Any catalog path counts
 * (this repository's own, the Claude Code path a copy could drag in, or a root
 * one), and a catalog may only return once README.md documents that rewriting;
 * until then its presence is the violation, whatever the file contains.
 */
function checkCatalog(project, violations, pkg) {
  const present = CATALOG_FILES.filter((rel) => project.read(rel) !== undefined);
  if (present.length === 0) return;

  const section = sectionBody(project.read('README.md'), MARKETPLACE_DOC_HEADING);
  if (section === undefined) {
    for (const rel of present) {
      fail(
        violations,
        'catalog.namespace-docs',
        `${rel} is back without namespace docs: README.md must carry a "${MARKETPLACE_DOC_HEADING}" section first, because a marketplace install rewrites the command and MCP server names this README documents`,
      );
    }
  } else {
    for (const [label, pattern] of MARKETPLACE_DOC_REQUIREMENTS) {
      if (!pattern.test(section)) {
        fail(violations, 'catalog.namespace-docs', `README.md ${MARKETPLACE_DOC_HEADING} does not document the rewritten ${label}`);
      }
    }
  }

  for (const rel of present) checkCatalogEntry(project, violations, pkg, rel);
}

/** Shape of one catalog file that returned: identity, plugin entry, and its source. */
function checkCatalogEntry(project, violations, pkg, rel) {
  const catalog = readJson(project, rel, violations, 'catalog.json-invalid');
  if (catalog === undefined) return;

  if (!validName(catalog.name, 64)) {
    fail(violations, 'catalog.name', `${rel} name ${JSON.stringify(catalog.name)} is not a valid marketplace name`);
  }

  if (!isPlainObject(catalog.owner) || !nonEmptyString(catalog.owner.name)) {
    fail(violations, 'catalog.owner', `${rel} owner.name must be a non-empty string`);
  }

  if (catalog.metadata !== undefined) {
    if (!isPlainObject(catalog.metadata)) {
      fail(violations, 'catalog.metadata', `${rel} metadata must be an object`);
    } else if (catalog.metadata.pluginRoot !== undefined && typeof catalog.metadata.pluginRoot !== 'string') {
      fail(violations, 'catalog.metadata', `${rel} metadata.pluginRoot must be a string`);
    }
  }

  if (!Array.isArray(catalog.plugins) || catalog.plugins.length === 0) {
    fail(violations, 'catalog.plugins', `${rel} plugins must be a non-empty array`);
    return;
  }

  for (const [index, entry] of catalog.plugins.entries()) {
    if (!isPlainObject(entry) || !validName(entry.name, 64)) {
      fail(violations, 'catalog.plugin-invalid', `${rel} plugins[${index}] needs a valid name`);
      continue;
    }
    if (entry.source === undefined) {
      fail(violations, 'catalog.plugin-invalid', `${rel} plugins[${index}] (${entry.name}) needs a source`);
    }
    if (entry.description !== undefined && typeof entry.description !== 'string') {
      fail(violations, 'catalog.plugin-invalid', `${rel} plugins[${index}] (${entry.name}) description must be a string`);
    }
    if (entry.version !== undefined && typeof entry.version !== 'string') {
      fail(violations, 'catalog.plugin-invalid', `${rel} plugins[${index}] (${entry.name}) version must be a string`);
    }
  }

  const entry = catalog.plugins.find((candidate) => isPlainObject(candidate) && candidate.name === PLUGIN_NAME);
  if (entry === undefined) {
    fail(violations, 'catalog.plugin-missing', `${rel} must list a ${PLUGIN_NAME} plugin`);
    return;
  }

  if (!nonEmptyString(entry.description)) {
    fail(violations, 'catalog.plugin-description', `${rel} plugin entry ${PLUGIN_NAME} needs a description`);
  }
  if (pkg !== undefined && entry.version !== undefined && entry.version !== pkg.version) {
    fail(
      violations,
      'catalog.plugin-version',
      `${rel} plugin entry version ${entry.version} does not match package.json version ${pkg.version}`,
    );
  }

  checkCatalogSource(project, violations, rel, entry.source);
}

/**
 * The plugin entry must resolve to this repository: a GitHub/URL source for
 * Symvanta/omp-plugin, or a relative source that resolves to the repository root
 * itself (the catalog ships inside the plugin it lists).
 */
function checkCatalogSource(project, violations, rel, source) {
  const code = 'catalog.plugin-source';
  const at = (message) => `${rel} ${message}`;

  if (typeof source === 'string') {
    if (!source.startsWith('./')) {
      fail(violations, code, at(`string source ${JSON.stringify(source)} must start with ./`));
      return;
    }
    const target = source.replace(/^\.\//, '').replace(/\/$/, '');
    if (target !== '' && target !== '.') {
      fail(violations, code, at(`relative source ${JSON.stringify(source)} points inside the repo, not at the repo itself`));
      return;
    }
    if (!pathExists(project, '.')) fail(violations, code, at('relative source resolves to nothing'));
    return;
  }

  if (!isPlainObject(source)) {
    fail(violations, code, at('source must be a string or an object'));
    return;
  }

  const type = source.source;
  if (type === 'github') {
    if (source.repo !== REPOSITORY) {
      fail(violations, code, at(`github source repo must be ${REPOSITORY}, found ${JSON.stringify(source.repo)}`));
    }
    return;
  }
  if (type === 'url' || type === 'git-subdir') {
    const url = String(source.url ?? '');
    if (!url.replace(/\.git$/, '').endsWith(`github.com/${REPOSITORY}`)) {
      fail(violations, code, at(`${type} source url must point at ${REPOSITORY}, found ${JSON.stringify(source.url)}`));
    }
    if (type === 'git-subdir' && !nonEmptyString(source.path)) {
      fail(violations, code, at('git-subdir source needs a path'));
    }
    return;
  }
  if (type === 'npm') {
    fail(violations, code, at('npm sources are rejected by the installer; use a git source instead'));
    return;
  }
  fail(violations, code, at(`unsupported source type ${JSON.stringify(type)}`));
}

// -------------------------------------------------------------------------- mcp

function checkMcp(project, violations) {
  const candidates = [];

  const mcpJson = project.read('.mcp.json');
  if (mcpJson !== undefined) {
    try {
      const parsed = JSON.parse(mcpJson);
      const server = parsed?.mcpServers?.[PLUGIN_NAME];
      if (server === undefined) {
        fail(violations, 'mcp.missing', `.mcp.json has no mcpServers.${PLUGIN_NAME} entry`);
      } else {
        candidates.push(['.mcp.json', server]);
      }
    } catch (error) {
      fail(violations, 'mcp.invalid', `.mcp.json is not valid JSON (${error.message})`);
    }
  }

  const pkgText = project.read('package.json');
  if (pkgText !== undefined) {
    try {
      const server = JSON.parse(pkgText)?.omp?.mcpServers?.[PLUGIN_NAME];
      if (server !== undefined) candidates.push(['package.json omp.mcpServers', server]);
    } catch {
      // Reported by the package check.
    }
  }

  if (candidates.length === 0) {
    fail(
      violations,
      'mcp.missing',
      `no ${PLUGIN_NAME} MCP server defined in .mcp.json or package.json omp.mcpServers`,
    );
    return;
  }

  for (const [origin, server] of candidates) {
    if (!isPlainObject(server)) {
      fail(violations, 'mcp.shape', `${origin} ${PLUGIN_NAME} server must be an object`);
      continue;
    }
    if (server.type !== 'http') {
      fail(violations, 'mcp.transport', `${origin} server type must be "http", found ${JSON.stringify(server.type)}`);
    }
    if (server.url !== MCP_URL) {
      fail(violations, 'mcp.url', `${origin} server url must be ${MCP_URL}, found ${JSON.stringify(server.url)}`);
    }
    if (server.timeout !== MCP_TIMEOUT_MS) {
      fail(violations, 'mcp.timeout', `${origin} server timeout must be ${MCP_TIMEOUT_MS}, found ${JSON.stringify(server.timeout)}`);
    }
  }

  if (candidates.length > 1) {
    const [first, ...rest] = candidates;
    const shape = ([, server]) => JSON.stringify([server.type, server.url, server.timeout]);
    for (const other of rest) {
      if (shape(other) !== shape(first)) {
        fail(violations, 'mcp.duplicate', `${first[0]} and ${other[0]} define different ${PLUGIN_NAME} servers`);
      }
    }
  }
}

// ------------------------------------------------------------------------- rule

function checkRules(project, violations) {
  const files = markdownFiles(project, 'rules');
  if (!files.includes('symvanta.md')) {
    fail(violations, 'rule.missing', `${RULE_FILE} is missing`);
  }

  for (const name of files) {
    const rel = `rules/${name}`;
    const text = project.read(rel);
    const parsed = parseFrontmatter(text);
    if (parsed.error) {
      fail(violations, 'rule.frontmatter', `${rel} ${parsed.error}`);
      continue;
    }
    for (const key of Object.keys(parsed.data)) {
      if (!RULE_KEYS.has(key)) {
        fail(violations, 'rule.key-unknown', `${rel} frontmatter key ${JSON.stringify(key)} is not read by the rule loader`);
      }
    }
  }

  const text = project.read(RULE_FILE);
  if (text === undefined) return;

  const parsed = parseFrontmatter(text);
  if (parsed.error) return; // Already reported above.

  const { data, body } = parsed;
  if (data.alwaysApply !== true) {
    fail(violations, 'rule.always-apply', `${RULE_FILE} must set alwaysApply: true (a glob-scoped or rulebook-only rule is not injected)`);
  }
  if (!nonEmptyString(data.description)) {
    fail(violations, 'rule.description', `${RULE_FILE} needs a non-empty description`);
  }
  if (data.name !== undefined && data.name !== PLUGIN_NAME) {
    fail(violations, 'rule.name', `${RULE_FILE} rule name must be ${PLUGIN_NAME}, found ${JSON.stringify(data.name)}`);
  }

  for (const [label, pattern] of RULE_REQUIREMENTS) {
    if (!pattern.test(body)) {
      fail(violations, 'rule.requirement', `${RULE_FILE} does not cover ${label}`);
    }
  }
}

// --------------------------------------------------------------------- commands

function checkCommands(project, violations) {
  const files = markdownFiles(project, 'commands');
  const names = files.map((name) => name.replace(/\.md$/, ''));

  for (const expected of COMMANDS) {
    if (!names.includes(expected)) {
      fail(violations, 'command.set', `commands/${expected}.md is missing`);
    }
  }
  for (const name of names) {
    if (!COMMANDS.includes(name)) {
      fail(violations, 'command.set', `commands/${name}.md is not part of the documented command set`);
    }
    if (!/^symvanta-[a-z0-9-]+$/.test(name)) {
      fail(violations, 'command.name', `commands/${name}.md must be named /symvanta-*`);
    }
  }

  for (const file of files) {
    const rel = `commands/${file}`;
    const text = project.read(rel);
    const parsed = parseFrontmatter(text);
    if (parsed.error) {
      fail(violations, 'command.frontmatter', `${rel} ${parsed.error}`);
      continue;
    }
    if (!nonEmptyString(parsed.data.description)) {
      fail(violations, 'command.description', `${rel} needs a non-empty description`);
    }
    if (parsed.data['argument-hint'] !== undefined && !nonEmptyString(parsed.data['argument-hint'])) {
      fail(violations, 'command.argument-hint', `${rel} argument-hint must be a non-empty string`);
    }

    const aggregate = parsed.body.match(/\$ARGUMENTS|\$@(?![[])/g) ?? [];
    if (aggregate.length !== 1) {
      fail(violations, 'command.placeholder', `${rel} must use exactly one $ARGUMENTS (or $@) placeholder, found ${aggregate.length}`);
    }
    if (/\$[1-9]/.test(parsed.body)) {
      fail(violations, 'command.placeholder', `${rel} uses a positional placeholder but declares no positional arguments`);
    }

    checkHostArtifacts(text, rel, violations, 'command.host-ism', COMMAND_ISM_PATTERNS);
  }
}

// ------------------------------------------------------------------------ skill

function checkSkill(project, violations) {
  const text = project.read(SKILL_FILE);
  if (text === undefined) {
    fail(violations, 'skill.missing', `${SKILL_FILE} is missing`);
    return;
  }
  const parsed = parseFrontmatter(text);
  if (parsed.error) {
    fail(violations, 'skill.frontmatter', `${SKILL_FILE} ${parsed.error}`);
    return;
  }
  if (parsed.data.name !== PLUGIN_NAME) {
    fail(violations, 'skill.name', `${SKILL_FILE} frontmatter name must be ${PLUGIN_NAME}`);
  }
  if (!nonEmptyString(parsed.data.description)) {
    fail(violations, 'skill.description', `${SKILL_FILE} needs a non-empty description`);
  }
  checkHostArtifacts(text, SKILL_FILE, violations, 'skill.host-ism', COMMAND_ISM_PATTERNS);
}

// ---------------------------------------------------------------------- runtime

function checkRuntime(project, violations) {
  const source = project.read(EXTENSION_FILE);
  if (source === undefined) {
    fail(violations, 'runtime.missing', `${EXTENSION_FILE} is missing`);
  } else {
    for (const event of EXPECTED_EVENTS) {
      if (!new RegExp(`["'\`]${event}["'\`]`).test(source)) {
        fail(violations, 'runtime.event', `${EXTENSION_FILE} does not register a ${event} handler`);
      }
    }
    for (const token of EXPECTED_RUNTIME_TOKENS) {
      if (!source.includes(token)) {
        fail(violations, 'runtime.token', `${EXTENSION_FILE} does not reference ${token}`);
      }
    }
    for (const [label, pattern] of EXPECTED_RUNTIME_PATTERNS) {
      if (!pattern.test(source)) {
        fail(violations, 'runtime.contract', `${EXTENSION_FILE} does not implement the ${label}`);
      }
    }

    const code = stripCodeComments(source);
    for (const [label, pattern] of FORBIDDEN_RUNTIME_PATTERNS) {
      if (pattern.test(code)) {
        fail(violations, 'runtime.direct-access', `${EXTENSION_FILE} performs a ${label}; MCP auth and transport stay inside OMP`);
      }
    }
  }

  const module = project.read(REPOSITORY_MODULE);
  if (module === undefined) {
    fail(violations, 'runtime.missing', `${REPOSITORY_MODULE} is missing`);
    return;
  }
  const moduleCode = stripCodeComments(module);
  for (const pattern of [/\bimport\b|\brequire\s*\(/, /\bprocess\.env/, /node:(?:fs|http|https|child_process)/]) {
    if (pattern.test(moduleCode)) {
      fail(violations, 'runtime.module-purity', `${REPOSITORY_MODULE} must stay dependency-free and pure`);
    }
  }
}

// ----------------------------------------------------------------------- readme

function checkReadme(project, violations) {
  const text = project.read('README.md');
  if (text === undefined) {
    fail(violations, 'readme.missing', 'README.md is missing');
    return;
  }

  if (!/^# \S/m.test(text)) {
    fail(violations, 'readme.heading', 'README.md needs an H1 title');
  }
  for (const section of README_SECTIONS) {
    if (!new RegExp(`^## ${section}\\b`, 'm').test(text)) {
      fail(violations, 'readme.section', `README.md is missing a "## ${section}" section`);
    }
  }
  for (const [label, snippet] of README_CLI_SNIPPETS) {
    if (!text.includes(snippet)) {
      fail(violations, 'readme.cli', `README.md does not document ${label} (${JSON.stringify(snippet)})`);
    }
  }
  for (const command of COMMANDS) {
    if (!text.includes(`/${command}`)) {
      fail(violations, 'readme.command', `README.md does not document /${command}`);
    }
  }
  checkHostArtifacts(text, 'README.md', violations, 'readme.host-ism', README_ISM_PATTERNS);
}

// ------------------------------------------------------------- foreign artifacts

function checkForeignArtifacts(project, violations) {
  if (project.read('hooks/hooks.json') !== undefined) {
    fail(violations, 'hooks.claude-json', 'hooks/hooks.json is a Claude Code wiring file; OMP wires hooks as extension events and hooks/pre|post modules');
  }
}

// -------------------------------------------------------------------------- main

export function collectViolations(project) {
  const violations = [];
  const pkg = checkPackage(project, violations);
  checkCatalog(project, violations, pkg);
  checkMcp(project, violations);
  checkRules(project, violations);
  checkCommands(project, violations);
  checkSkill(project, violations);
  checkRuntime(project, violations);
  checkReadme(project, violations);
  checkForeignArtifacts(project, violations);
  return violations;
}

function main() {
  const violations = collectViolations(projectFromDisk(projectRoot()));
  if (violations.length > 0) {
    console.error(`Symvanta OMP plugin contract: ${violations.length} violation(s)\n`);
    for (const violation of violations) console.error(`  ${violation}`);
    console.error('\nFix the violations above; see README.md for the documented contract.');
    process.exitCode = 1;
    return;
  }
  console.log('Symvanta OMP plugin contract: OK');
  console.log(
    '  package.json manifest, no marketplace catalog, MCP server, rule, commands, skill, extension, README',
  );
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
