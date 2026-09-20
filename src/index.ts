/**
 * Symvanta code-graph plugin for Oh My Pi (OMP).
 *
 * OMP extensions replace the Claude plugin's subprocess hooks. The Claude plugin
 * shipped `hooks/*.js` programs that Claude Code spawned per event, with JSON on
 * stdin and a JSON envelope on stdout. OMP loads a module like this one into the
 * agent process instead, so the same behavior is expressed as extension
 * handlers: the session primer is the `session_start` handler below, repeated
 * when `/new` emits `session_switch` with reason `new`, and the PreToolUse
 * Edit/Write augmenter is the `tool_call` impact guard (which can refuse a
 * call, not only add context). There is no child process, no hook envelope,
 * and no per-tool-call spawn cost.
 *
 * Four surfaces sit on top of that MCP server, and none of them talks to it:
 *
 *   - the impact guard, whose strength is SYMVANTA_IMPACT_MODE (once, strict,
 *     warn, off) and whose refusal text is the only thing it says about a
 *     mutation;
 *   - the status widget, a view over `init`, `freshness`, and `index_health`
 *     results the session already received;
 *   - the guidance augmenters, which inject a hidden note about the graph call
 *     that would answer the same question, and say in the note that they did not
 *     query anything;
 *   - the twelve `/symvanta-*` commands, registered by the extension so the
 *     documented names survive marketplace namespace rewriting, rendering the
 *     same markdown templates the file commands use.
 *
 * Symvanta is reached exclusively through the MCP server declared in .mcp.json.
 * A host that does not surface those tools directly delivers each call as
 * `write` to an `xd://mcp__symvanta_<tool>` device path with the JSON arguments
 * in `content`; one unwrapping seam (`logicalInvocation`) turns that into the
 * same logical call a direct MCP invocation already is, and the impact guard,
 * the status widget, and the attachment observation all read it.
 *
 * This module never opens an HTTP connection of its own, never reads OMP's OAuth
 * or credential storage, and never uploads file contents: the only things it
 * reads are the origin remote URL, the bundled command templates, and the
 * results the host hands it.
 *
 * Load-time rule: nothing acts during module load. Registration happens in the
 * factory (`setLabel`, `on`, `registerCommand`), and every runtime action
 * (`getAllTools`, `sendMessage`, `sendUserMessage`, the UI setters) runs from an
 * event handler or a command handler, after the runner is initialized.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import {
  augmentEnabled,
  extractPromptTerms,
  guideKey,
  GUIDE_LIMITS,
  promptGuidance,
  readGuidance,
  rescueGuidance,
  searchGuidance,
  searchTarget,
} from "./augment.js";
import { commandDirectory, loadCommandTemplate, renderCommandTemplate, SYMVANTA_COMMANDS } from "./commands.js";
import { impactBlockLimit, impactBlocks, parseImpactMode, warnGuidance } from "./impact.js";
import { buildStartupContext, parseGitHubRemote } from "./repository.js";
import { statusFromToolResult } from "./status.js";

/** Local git reads are fast; the bound only exists so a stuck git cannot stall a session. */
const GIT_TIMEOUT_MS = 2000;
const GIT_MAX_BUFFER = 64 * 1024;

/** Tools that mutate an existing code file, including the edit tool's apply_patch wire name. */
const EDIT_TOOLS: Record<string, true> = { edit: true, write: true, apply_patch: true };

/** Extensions the graph indexes as code. Anything else passes the impact guard untouched. */
const CODE_EXTENSIONS: Record<string, true> = {
  ts: true, tsx: true, mts: true, cts: true, js: true, jsx: true, mjs: true, cjs: true,
  py: true, go: true, rs: true, java: true, kt: true, kts: true, rb: true, php: true,
  cs: true, swift: true, scala: true, c: true, h: true, cc: true, cpp: true, hpp: true,
  m: true, mm: true, sh: true, bash: true, zsh: true, lua: true, dart: true, ex: true,
  exs: true, erl: true, clj: true, cljs: true, hs: true, sql: true, vue: true,
  svelte: true, astro: true,
};

/**
 * The impact guard refuses at most this many mutations per session in its
 * default `once` mode. It exists so a model that ignores the refusal (or a
 * server-side check that never succeeds) cannot deadlock a session: after the
 * first refusal the guard fails open. `strict` raises the cap to infinity on
 * purpose, because asking for it means asking not to fail open.
 */
const MAX_GUARD_BLOCKS = 1;

/** The UI key the footer status and the below-editor widget are both published under. */
const STATUS_KEY = "symvanta";

/** Custom message types this extension injects. The primer keeps its original name. */
const PRIMER_TYPE = "symvanta.repository";
const GUIDANCE_TYPE = "symvanta.guidance.";

/** The read and grep tools whose calls the augmenters recognize. */
const READ_TOOL = "read";
const GREP_TOOL = "grep";

/** The one host tool an XD device call arrives through: `write` to an `xd://` path. */
const WRITE_TOOL = "write";

/** An XD device path: the `xd://` scheme and the device or MCP tool it names. */
const XD_DEVICE = /^xd:\/\//i;

/**
 * The device name of one of Symvanta's own MCP tools. Ownership is proven at
 * the start, never by the tail: the wire name has to be the MCP form the host
 * mints for the Symvanta server (`mcp__symvanta_relate`), its Claude-doubled
 * separator spelling (`mcp__symvanta__relate`), or the marketplace-doubled
 * `mcp__symvanta_symvanta_relate`, with a tail from the known-tool table. A
 * device that merely ends in the same letters (`mcp__github_symvanta_relate`)
 * or that prefixes the token (`mcp__notsymvanta_relate`) is not Symvanta's, so
 * nothing it returns can move this session's status, attachment, or guard.
 */
const XD_SYMVANTA_DEVICE = /^mcp__symvanta(?:(?:__|_)symvanta)?(?:__|_)([a-z0-9_]+)$/i;

/**
 * The host's write-device sentinel for "show docs instead of executing". OMP's
 * help predicate is the same shape with the same flags, and a content that
 * matches it answers with a successful help result that never reached a tool,
 * which is why such a call may not count as an executed Symvanta call.
 */
const DEVICE_HELP = /^\s*(\?|help)?\s*$/i;

/** Widget lines shown below the editor. Three is the whole point: it sits under the prompt. */
const STATUS_PLACEMENT = "belowEditor";

/**
 * The tools the Symvanta server exposes. A host mints MCP tools as
 * `mcp__<server>_<tool>`, so a wire name has to be read back to its bare name
 * before it can be compared against the impact pair; this table is what makes
 * that read unambiguous when the tool name itself contains underscores
 * (`estimate_scope`) and when the server token is repeated
 * (`mcp__symvanta_symvanta_relate`).
 */
const SYMVANTA_TOOLS: Record<string, true> = {
  add_repository: true, adr: true, ask_codebase: true, bundle: true, context: true,
  create_project: true, diff_impact: true, estimate_scope: true, find_http_route: true,
  find_node: true, freshness: true, history: true, index_health: true, init: true,
  library: true, list_file_symbols: true, list_installations: true, list_projects: true,
  list_repositories: true, list_tests_for: true, locate: true, map: true,
  quick_lookup: true, ref: true, reindex_repository: true, relate: true, source: true,
};

/** A whole `symvanta` token and the separator run a host appends before the tool name. */
const SYMVANTA_NAMESPACE = /(?<![A-Za-z0-9])symvanta(?:__|[_:-])+/gi;

/** A hashline section header, `[path#TAG]`: the file that section edits. */
const HASHLINE_HEADER = /^\s*\[([^\]\n]+?)#[^\]]*\]/gm;

/** An apply_patch file marker: `*** Update File: path` and its Add/Delete siblings. */
const APPLY_PATCH_HEADER = /^\s*\*\*\* (?:Update|Delete|Add) File:\s*(.+?)\s*$/gm;

/**
 * A sloppy-mode section header. `*** SM:EDIT path/to/file.ts` opens edits in a
 * file, a bare `*** SM:EDIT` continues the file the current section already
 * named, and `*** SM:EDIT all` only widens the match, so the first two name a
 * file and the third names none. Case-insensitive, like the mode's own parser.
 */
const SLOPPY_HEADER = /^\s*\*{3}\s*SM:EDIT\b([^\n]*)$/gim;

/**
 * The XML-ish section a model sometimes writes instead of the header,
 * `<SM:EDIT path="src/a.ts">`, with or without the `***` the real header needs.
 */
const SLOPPY_TAG_HEADER = /^\s*(?:\*{3}\s*)?<SM:EDIT\b([^>\n]*)>/gim;

/** The `path` (or `file`) attribute of a sloppy tag: quoted with either quote, or bare. */
const SLOPPY_TAG_PATH = /\b(?:path|file)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

/** A path wrapper a model copied from tool output: `[path#TAG]`, or a bare `[path]`. */
const COPIED_HEADER = /^\[([^\]#]+)(?:#[^\]]*)?\]$/;

/** A path still wrapped in the quotes a model echoed around it. */
const QUOTED_PATH = /^(["'])([\s\S]*)\1$/;

/** A `file://` URL, the one scheme whose remainder is a plain path. */
const FILE_URL = /^file:\/\//i;

/** A URL with an authority (`https://`, `xd://`, `vault://`), which is never a filesystem path. */
const URL_SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;

/** A Windows drive (`C:\`, `C:/`): a path even though `C://` also parses as a scheme. */
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

/** Unicode spaces OMP's PathPolicy folds to a plain space before resolving. */
const UNICODE_SPACES = /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g;

/** Argument names a host may use for the file a mutation targets. */
const PATH_FIELDS = ["path", "file_path", "filePath", "paths", "filePaths", "files"] as const;

/** Depth bound for a bridged input that wraps the real one, so a cycle cannot recurse forever. */
const MAX_TARGET_DEPTH = 4;

type ToolAvailability = { relate: boolean; estimateScope: boolean };

/**
 * The logical Symvanta call a tool event carries: the bare tool name and the
 * arguments it was given, whichever transport delivered it. `bridged` marks the
 * XD device transport (`write` to an `xd://` path), the one transport where a
 * successful `init` is also the only proof the MCP server is reachable at all.
 * `executable` is whether the Symvanta tool actually ran: a device write that
 * answered docs, or whose content was absent, malformed, or not a JSON object,
 * completed without it and may not satisfy the guard, move the status, or arm
 * anything. A direct MCP call always ran.
 */
type ToolInvocation = { tool: string; input: unknown; bridged: boolean; executable: boolean };

/** The impact-guard strength this session runs at, parsed once from the environment. */
type ImpactMode = "once" | "strict" | "warn" | "off";

type SessionState = {
  /** A Symvanta impact check completed successfully in this session: the guard is satisfied. */
  impactObserved: boolean;
  /**
   * Impact checks this session issued that have not resolved yet, keyed by tool
   * call id. A call in flight is deliberately not satisfaction: OMP fires
   * `tool_call` for a whole model batch before executing it, so crediting the
   * check when it is merely issued would let an edit scheduled alongside it ride
   * through on a check that may still fail.
   */
  pendingImpact: Set<string>;
  /** Mutations this session already refused, capped by MAX_GUARD_BLOCKS under `once`. */
  blocks: number;
  /** Whether the Symvanta impact tools were present the last time they were probed. */
  hasImpactTool: boolean;
  /** Symvanta tools found on the last probe, so the refusal names only real options. */
  tools: ToolAvailability;
  /**
   * SYMVANTA_IMPACT_MODE, resolved once per session so a mid-session environment
   * change cannot make the guard behave differently between two edits.
   */
  impactMode: ImpactMode;
  /**
   * What a Symvanta `init` result observed about this checkout:
   * `workspace.attached`. Null is "unknown", which is where every session
   * starts: a direct Git install is user-wide, so this checkout may be one
   * Symvanta has never seen, and nothing may advise or refuse until a result
   * says otherwise. Only an observed boolean moves it.
   */
  attached: boolean | null;
  /** Guidance this session already sent, so the same note is not repeated. */
  guided: Set<string>;
  /** Guidance sent per kind this session, bounded by GUIDE_LIMITS. */
  guides: Record<string, number>;
  /** Guidance sent across all kinds this session, bounded by GUIDE_LIMITS.total. */
  guideTotal: number;
};

type HandlerContext = {
  cwd?: string;
  hasUI?: boolean;
  ui?: {
    notify: (message: string, level?: string) => void;
    setStatus?: (key: string, text?: string) => void;
    setWidget?: (key: string, content?: readonly string[], options?: { placement?: string }) => void;
  };
  sessionManager?: { getSessionId?: () => string };
};

/** Sessions are separate: a process can host several, and each satisfies the guard on its own. */
const sessions = new Map<string, SessionState>();

/**
 * A record view of an event payload. Handlers receive structurally typed
 * events, but this module reads them through `unknown` on purpose: a host
 * version that renames or drops a field must not crash a handler that only
 * wanted to look at it. Narrowing once here keeps every read a checked property
 * access on a named value, and an array or a primitive reads as an empty record
 * rather than as a carrier of stray fields.
 */
function eventRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

/** Session id when the runtime can supply one, else a shared bucket for the process. */
function sessionKey(ctx: HandlerContext): string {
  try {
    const id = ctx.sessionManager?.getSessionId?.();
    if (typeof id === "string" && id.length > 0) return id;
  } catch {
    // Fall through to the shared bucket.
  }
  return "default";
}

function stateFor(ctx: HandlerContext): SessionState {
  const key = sessionKey(ctx);
  let state = sessions.get(key);
  if (!state) {
    state = {
      impactObserved: false,
      pendingImpact: new Set<string>(),
      blocks: 0,
      hasImpactTool: false,
      tools: { relate: false, estimateScope: false },
      impactMode: parseImpactMode(process.env),
      attached: null,
      guided: new Set<string>(),
      guides: {},
      guideTotal: 0,
    };
    sessions.set(key, state);
  }
  return state;
}

/**
 * Bare tool name when a wire name is shaped like one of Symvanta's, else null.
 * Everything after the last whole `symvanta` token is the tool name, which is
 * what lets every prefixing scheme resolve alike: `symvanta_relate`,
 * `mcp__symvanta_relate`, `mcp__symvanta__relate`, and the marketplace-shaped
 * `mcp__symvanta_symvanta_relate` all yield `relate`, and
 * `mcp__symvanta_symvanta_estimate_scope` yields `estimate_scope` even though
 * the tool name contains a separator of its own. The known-tool check is what
 * keeps the read honest: a name that never says `symvanta` (`mcp__github_relate`)
 * or whose tail is not a Symvanta tool (`mcp__symvanta_relate_extra`) is not
 * Symvanta's, and the token has to be a whole one, so a server that merely ends
 * in the same letters (`mcp__notsymvanta_relate`) is not either.
 */
function namespacedToolName(candidate: string): string | null {
  const value = candidate.trim().toLowerCase();
  let start = -1;
  for (const match of value.matchAll(SYMVANTA_NAMESPACE)) start = (match.index ?? 0) + match[0].length;
  if (start < 0) return null;

  const bare = value.slice(start);
  return Object.hasOwn(SYMVANTA_TOOLS, bare) ? bare : null;
}

/**
 * Bare Symvanta tool name ("relate", "estimate_scope") for a tool definition or
 * a tool-call name, or null when the tool is not Symvanta's. MCP tools carry
 * their origin on the definition, which is checked first: a server named after
 * Symvanta settles the question, in either the direct or the marketplace-doubled
 * spelling, so its tool name is unwrapped when it carries a namespace and
 * otherwise trusted as given, which keeps a renamed or newly added tool
 * working. Without that, the name shape is the only evidence, and it has to
 * look like a Symvanta wire name to count.
 */
function symvantaToolName(tool: unknown): string | null {
  let name = "";
  let server = "";
  let mcpName = "";

  if (typeof tool === "string") {
    name = tool;
  } else if (tool && typeof tool === "object") {
    const record = tool as Record<string, unknown>;
    if (typeof record.name === "string") name = record.name;
    if (typeof record.mcpServerName === "string") server = record.mcpServerName;
    if (typeof record.mcpToolName === "string") mcpName = record.mcpToolName;
  }

  if (server.trim().toLowerCase().includes("symvanta")) {
    const declared = (mcpName || name).trim().toLowerCase();
    return namespacedToolName(declared) ?? (declared || null);
  }
  return namespacedToolName(name);
}

/**
 * The device URL a write call targets, or null when it targets none. OMP
 * reaches a mounted XD device by calling `write` with an `xd://` URL where a
 * file path would go, and only the write tool's own argument names are read:
 * the first string field naming an `xd://` URL decides, so an ordinary file
 * write is never mistaken for a device call whatever else it carries.
 */
function devicePath(input: unknown): string | null {
  const record = eventRecord(input);
  for (const field of PATH_FIELDS) {
    const value = record[field];
    const candidates = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
    for (const candidate of candidates) {
      if (typeof candidate !== "string") continue;
      const target = candidate.trim();
      if (XD_DEVICE.test(target)) return target;
    }
  }
  return null;
}

/**
 * The JSON arguments a device write carries, and whether the device executed
 * them. OMP hands a device its arguments as `content`: an object is already
 * parsed, and a string is the JSON encoding of one. The host reserves a content
 * that is missing, empty, or the `?`/`help` sentinel for its docs answer, and
 * it rejects malformed JSON and non-object values with an error, so none of
 * those ever ran the tool: they carry no arguments and are marked
 * non-executable, which keeps a docs answer from passing for a completed call.
 */
function deviceArguments(content: unknown): { input: Record<string, unknown>; executable: boolean } {
  if (content !== null && typeof content === "object" && !Array.isArray(content)) {
    return { input: content as Record<string, unknown>, executable: true };
  }
  if (typeof content === "string" && !DEVICE_HELP.test(content)) {
    try {
      const parsed: unknown = JSON.parse(content);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { input: parsed as Record<string, unknown>, executable: true };
      }
    } catch {
      // Malformed JSON names no arguments and ran no tool.
    }
  }
  return { input: {}, executable: false };
}

/**
 * Whether a write result says the device answered docs instead of executing.
 * OMP attaches `{ xdev: { tool, mode, ... } }` to every device write's result
 * details, and only `mode: "help"` never reached the tool. Absent or foreign
 * metadata reads as an execution, because every other mode is one.
 */
function deviceAnsweredHelp(details: unknown): boolean {
  const mode = eventRecord(eventRecord(details).xdev).mode;
  return typeof mode === "string" && mode.trim().toLowerCase() === "help";
}

/**
 * The logical Symvanta call a tool event carries, or null when the event is not
 * one. Two transports land here and nowhere else: a direct MCP call
 * (`mcp__symvanta_relate`, whose input is already the arguments) and an XD
 * device call (`write` to `xd://mcp__symvanta_relate`, whose arguments travel
 * as JSON in `content`). Both yield the same logical invocation, so the impact
 * gate, the status widget, and the attachment observation read one shape
 * instead of each knowing which transport carried the call.
 *
 * Everything else keeps its raw handling: an ordinary file write, an XD device
 * of another kind, and a malformed device path are not Symvanta calls. The
 * result-side `details` are read too, because the host's xdev metadata is the
 * only way to tell a device call that ran from one that answered docs.
 */
function logicalInvocation(toolName: unknown, input: unknown, details?: unknown): ToolInvocation | null {
  const name = typeof toolName === "string" ? toolName.trim().toLowerCase() : "";
  if (name === WRITE_TOOL) {
    const device = devicePath(input);
    if (device === null) return null;
    // The query and fragment of a device URL never name the tool, so they are
    // dropped before the ownership read; the wire name is what remains.
    const owned = XD_SYMVANTA_DEVICE.exec(device.replace(XD_DEVICE, "").replace(/[?#][\s\S]*$/, "").toLowerCase());
    if (owned === null || !Object.hasOwn(SYMVANTA_TOOLS, owned[1])) return null;
    const args = deviceArguments(eventRecord(input).content);
    return { tool: owned[1], input: args.input, bridged: true, executable: args.executable && !deviceAnsweredHelp(details) };
  }
  const tool = symvantaToolName(toolName);
  return tool === null ? null : { tool, input, bridged: false, executable: true };
}

/** Whether the connected Symvanta server exposes the impact tools the guard relies on. */
function findSymvantaTools(pi: ExtensionAPI): ToolAvailability {
  const found: ToolAvailability = { relate: false, estimateScope: false };
  let tools: unknown;
  try {
    tools = pi.getAllTools();
  } catch {
    return found;
  }
  if (!Array.isArray(tools)) return found;

  for (const tool of tools) {
    const bare = symvantaToolName(tool);
    if (bare === "relate") found.relate = true;
    else if (bare === "estimate_scope") found.estimateScope = true;
  }
  return found;
}

/** A model call that performs the pre-edit impact check: estimate_scope, or relate(kind: blast_radius). */
function isImpactCheckCall(toolName: unknown, input: unknown): boolean {
  const name = typeof toolName === "string" ? toolName : "";
  if (name.length === 0) return false;

  const bare = symvantaToolName(name) ?? name.toLowerCase();
  if (bare === "estimate_scope") return true;
  if (bare !== "relate") return false;

  const kind = input && typeof input === "object" ? (input as Record<string, unknown>).kind : undefined;
  if (typeof kind !== "string") return false;
  return kind.trim().toLowerCase().replace(/[\s_-]/g, "") === "blastradius";
}

/**
 * The tool call id an event is about, or null when the host supplied none.
 * `tool_call` and `tool_result` both carry it, which is what lets the guard pair
 * a mutation with the check that actually ran before it instead of trusting that
 * one was issued.
 */
function toolCallIdOf(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const value = (event as Record<string, unknown>).toolCallId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The path a sloppy section header names, or null when it names none: a bare
 * `SM:EDIT` continues the current file, and `all` only widens the match. A
 * trailing `all` flag is dropped from the path it qualifies, and a JSON-quoted
 * path keeps its quotes for the shared unquoting step.
 */
function sloppyHeaderPath(rest: string): string | null {
  let value = rest.trim();
  if (value.length === 0 || /^all$/i.test(value)) return null;

  const quoted = /^"(?:[^"\\]|\\.)*"/.exec(value);
  if (quoted) {
    const tail = value.slice(quoted[0].length).trim();
    return tail.length === 0 || /^all$/i.test(tail) ? quoted[0] : null;
  }

  if (/\sall$/i.test(value)) value = value.slice(0, -3).trimEnd();
  return value.length > 0 ? value : null;
}

/** The path a sloppy `<SM:EDIT ...>` tag names, or null when it carries no usable `path`/`file` attribute. */
function sloppyTagPath(attributes: string): string | null {
  const match = SLOPPY_TAG_PATH.exec(attributes);
  if (!match) return null;

  const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
  return value.length > 0 ? value : null;
}

/** Paths a payload names through `header`, keeping only the matches `extract` reads as a file. */
function headerPaths(payload: string, header: RegExp, extract: (tail: string) => string | null): string[] {
  const targets: string[] = [];
  for (const match of payload.matchAll(header)) {
    const target = extract(match[1]);
    if (target !== null) targets.push(target);
  }
  return targets;
}

/**
 * Paths named by a patch payload: hashline `[path#TAG]` section headers, the
 * apply_patch file markers (`*** Update File:`, `*** Delete File:`,
 * `*** Add File:`), and both sloppy section spellings (`*** SM:EDIT path` and
 * the XML-ish `<SM:EDIT path="...">`). Only a payload is scanned, never a
 * `content` field: text being written is not a target, so a file that merely
 * quotes a patch never matches. An `Add File:` target is no exception here, it
 * is simply a path that usually does not exist yet and so passes the exists
 * check below.
 */
function payloadTargets(payload: string): string[] {
  return [
    ...headerPaths(payload, HASHLINE_HEADER, (tail) => tail),
    ...headerPaths(payload, APPLY_PATCH_HEADER, (tail) => tail),
    ...headerPaths(payload, SLOPPY_HEADER, sloppyHeaderPath),
    ...headerPaths(payload, SLOPPY_TAG_HEADER, sloppyTagPath),
  ];
}

/**
 * The local path a model-spelled target names, following OMP's PathPolicy: a
 * leading `:` or `@` prefix, unicode spaces folded to a plain space, a `file://`
 * URL decoded, the Windows verbatim prefix dropped, and `~`, `~/x`, `~\x`, or
 * `~x` expanded with the OS home directory. A leading `@` or `:` is only an
 * alias when what follows could be a path, so `@vault://x` keeps its `@` and is
 * refused below rather than silently becoming one.
 *
 * Returns null when the value names no local file at all: a file URL with a
 * broken escape, or any other scheme (`https://`, `xd://`, `vault://`), which
 * OMP resolves through a handler of its own and never as a filesystem path.
 * Resolving those against the cwd is exactly what would make the guard stat a
 * file no mutation tool would touch.
 */
function normalizeAlias(candidate: string): string | null {
  let value = candidate;

  if (value.startsWith(":")) {
    const rest = value.slice(1);
    if (
      rest.startsWith("/") ||
      rest.startsWith("\\") ||
      rest.startsWith("~") ||
      rest.startsWith("./") ||
      rest.startsWith("../") ||
      WINDOWS_DRIVE.test(rest)
    ) {
      value = rest;
    }
  }
  if (value.startsWith("@")) {
    const rest = value.slice(1);
    if (
      rest.startsWith("/") ||
      rest.startsWith("\\") ||
      rest === "~" ||
      rest.startsWith("~/") ||
      rest.startsWith("local:") ||
      WINDOWS_DRIVE.test(rest) ||
      URL_SCHEME.test(rest)
    ) {
      value = rest;
    }
  }

  value = value.replace(UNICODE_SPACES, " ");

  if (FILE_URL.test(value)) {
    // The percent-decoded remainder is the path; a broken escape names no file,
    // so the target is dropped rather than guessed at.
    try {
      value = decodeURIComponent(value.slice(7));
    } catch {
      return null;
    }
  } else {
    const scheme = URL_SCHEME.exec(value);
    if (scheme !== null && !WINDOWS_DRIVE.test(value)) return null;
  }

  if (value.startsWith("\\\\?\\")) value = value.slice(4);
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(homedir(), value.slice(2));
  if (value.startsWith("~")) return path.join(homedir(), value.slice(1));
  return value;
}

/**
 * A target as the model spelled it. A copied `[path]` or `[path#TAG]` header and
 * surrounding single or double quotes are stripped, so `src/a.ts`,
 * `"src/a.ts"`, `[src/a.ts]`, and `[src/a.ts#1A2B]` all resolve to the same
 * file. The wrappers nest (`"[src/a.ts#1A2B]"`), so they are applied until the
 * value stops changing.
 */
function normalizeTarget(candidate: string): string {
  let value = candidate.trim();
  for (let pass = 0; pass < 3; pass += 1) {
    const copied = COPIED_HEADER.exec(value);
    const quoted = copied ? null : QUOTED_PATH.exec(value);
    const next = (copied ? copied[1] : quoted ? quoted[2] : value).trim();
    if (next === value) break;
    value = next;
  }
  return value;
}

/**
 * File paths a mutation call targets. OMP's edit modes cover three shapes: the
 * `path` field (`replace`, `patch`), a hashline, apply_patch, or sloppy payload
 * in `input`, and a payload handed over as the whole input. Arrays and a nested
 * `input` object are descended into because a bridged call can arrive wrapped
 * in either, and a string is read both ways: as the path it may be and as the
 * payload it may name paths in. Every field contributes rather than the first
 * non-empty one winning, so no shape can hide a target behind another.
 */
function editTargets(input: unknown, depth = 0): string[] {
  if (depth > MAX_TARGET_DEPTH) return [];
  if (typeof input === "string") return [input, ...payloadTargets(input)];
  if (Array.isArray(input)) return input.flatMap((entry) => editTargets(entry, depth + 1));
  if (!input || typeof input !== "object") return [];

  const record = input as Record<string, unknown>;
  const targets: string[] = [];
  for (const field of PATH_FIELDS) {
    const value = record[field];
    if (typeof value === "string") targets.push(value);
    else if (Array.isArray(value)) targets.push(...editTargets(value, depth + 1));
  }

  if (record.input !== undefined) targets.push(...editTargets(record.input, depth + 1));
  return targets;
}

/**
 * One line-range chunk of a read selector, without the colon: `50`, `L50`,
 * `50-`, `5-16`, `L5-L16`, `5..16`, `5+150`, and `-60` (the last N lines) all
 * name lines. The grammar is OMP's own (`splitPathAndSel` ->
 * `parseLineRangeChunk`), where `..` is a forgiving alias for `-`, a bare
 * trailing `-` or `..` is open-ended, and `+C` counts `C` lines from the start.
 */
const RANGE_CHUNK = String.raw`(?:L?\d+(?:-(?:L?\d*)|\.\.(?:L?\d*)|\+L?\d+)?|-\d+)`;

/**
 * A trailing read selector: a comma-joined range list, a mode word (`raw`,
 * `img`, `conflicts`), or any ordering of the two (`:raw:5-16`, `:5-16:raw`).
 * The prefix is matched lazily and the whole match is anchored, so the tail has
 * to be *entirely* selectors: a Windows drive, an `archive.zip:member`, or a
 * `src/a.ts:member` tail fails the match and stays part of the path, which is
 * what the host's own parser does.
 *
 * The pattern alone cannot tell a selector from a filename, though: `:2024` is
 * a valid `:N` in both, so a real file named `src/report:2024` looks exactly
 * like a line read. That case is settled by literal-path precedence in
 * `readTarget`, not here, because only the filesystem can answer it.
 */
const READ_SELECTOR = new RegExp(String.raw`^([\s\S]*?)(?::(?:${RANGE_CHUNK}(?:,${RANGE_CHUNK})*|raw|img|conflicts))+$`);

/** `existsSync` with the failure contained: a path that cannot be stat'd is not there. */
function existsQuietly(absolute: string): boolean {
  try {
    return existsSync(absolute);
  } catch {
    return false;
  }
}

/**
 * The first target of this mutation that already exists and is a code file, or
 * null when the call creates new files, or touches only non-code files, both of
 * which always pass.
 */
function gatedTarget(input: unknown, cwd: string): string | null {
  for (const candidate of editTargets(input)) {
    const cleaned = normalizeAlias(normalizeTarget(candidate));
    if (cleaned === null || cleaned.length === 0) continue;

    const absolute = path.resolve(cwd, cleaned);
    if (!Object.hasOwn(CODE_EXTENSIONS, path.extname(absolute).slice(1).toLowerCase())) continue;
    if (existsQuietly(absolute)) return absolute;
  }
  return null;
}

/**
 * The code file a read call opens, or null when it opens none. Reading does not
 * require the file to exist the way editing does, and a read may carry a line
 * range or a mode (`src/a.ts:50-200`, `src/a.ts:raw:5..16`), which the path read
 * drops before the extension check.
 *
 * A literal path wins over selector interpretation, exactly as the host decides
 * it: a file that really is named `report:1` is read as that file, and only a
 * path that is not there is read as its selector-stripped form. That is what
 * keeps a colon in a filename from being mistaken for a line range.
 */
function readTarget(input: unknown, cwd: string): string | null {
  for (const candidate of editTargets(input)) {
    const cleaned = normalizeAlias(normalizeTarget(candidate));
    if (cleaned === null || cleaned.length === 0) continue;

    const absolute = path.resolve(cwd, cleaned);
    const selector = READ_SELECTOR.exec(cleaned);
    const stripped = selector === null ? absolute : path.resolve(cwd, selector[1]);
    const candidates = selector === null || existsQuietly(absolute) ? [absolute, stripped] : [stripped, absolute];

    for (const target of candidates) {
      if (Object.hasOwn(CODE_EXTENSIONS, path.extname(target).slice(1).toLowerCase())) return target;
    }
  }
  return null;
}

/**
 * The refusal the guard returns, phrased for the mode that produced it: `once`
 * stops after one, `strict` keeps refusing until a check completes.
 */
function blockReason(relativePath: string, tools: ToolAvailability, mode: ImpactMode): string {
  const options: string[] = [];
  if (tools.estimateScope) options.push("estimate_scope for a task-level estimate");
  if (tools.relate) options.push('relate with kind "blast_radius" for the symbol this change touches');
  const check = options.length > 0 ? options.join(", or ") : "a Symvanta impact check";

  const cap = mode === "strict"
    ? "This session runs SYMVANTA_IMPACT_MODE=strict, so the guard keeps refusing until that check completes."
    : "This guard stops refusing after its first refusal; SYMVANTA_IMPACT_MODE=strict keeps refusing instead, warn advises without blocking, and off disables the guard.";

  return [
    `Symvanta impact guard: ${relativePath} already exists and no Symvanta impact check has run in this session.`,
    "OMP extensions replace the Claude plugin's PreToolUse subprocess hooks, so this check is enforced in process, before the mutation lands.",
    `Run ${check}, then retry this call. As a user-invoked alternative, /symvanta-blast reports the same surface.`,
    `New files and non-code files are never gated. ${cap}`,
  ].join("\n");
}

/**
 * Read one git value, or null when git is missing, cwd is not a checkout, or the
 * key has no value. execFile runs git directly: no shell is involved, so the
 * argument list cannot be re-parsed or injected into, and the timeout plus
 * SIGKILL mean a stuck git can never hold a session start open.
 */
function readGitValue(cwd: string, args: string[]): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  try {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { timeout: GIT_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
      (error, stdout) => {
        resolve(error ? null : String(stdout ?? "").trim() || null);
      },
    );
  } catch {
    resolve(null);
  }
  return promise;
}

/** The checkout's shape, read locally: a GitHub slug when there is one, and whether this is a checkout at all. */
async function readCheckout(cwd: string): Promise<{ slug: string | null; isCheckout: boolean }> {
  const [root, origin] = await Promise.all([
    readGitValue(cwd, ["rev-parse", "--show-toplevel"]),
    readGitValue(cwd, ["config", "--get", "remote.origin.url"]),
  ]);
  return { slug: parseGitHubRemote(origin)?.slug ?? null, isCheckout: root !== null };
}

/** Starts a session's guard state over: unsatisfied, unblocked, tools re-probed, mode re-read. */
function resetSessionState(pi: ExtensionAPI, ctx: HandlerContext): void {
  const state = stateFor(ctx);
  state.impactObserved = false;
  state.pendingImpact.clear();
  state.blocks = 0;
  state.tools = findSymvantaTools(pi);
  state.hasImpactTool = state.tools.relate || state.tools.estimateScope;
  state.impactMode = parseImpactMode(process.env);
  state.attached = null;
  state.guided.clear();
  state.guides = {};
  state.guideTotal = 0;
}

/**
 * Reserve one guidance slot for this session: false when this note was already
 * sent, or when the kind or the session has spent its budget. Reserving before
 * delivery is what keeps a re-entrant preparation (OMP may run the whole
 * `before_agent_start` chain again for one submission) from sending twice.
 */
function claimGuidance(state: SessionState, kind: string, key: string): boolean {
  const dedupe = augmentEnabled(process.env, "dedupe");
  if (dedupe && state.guided.has(key)) return false;
  if ((state.guides[kind] ?? 0) >= (GUIDE_LIMITS[kind] ?? 0)) return false;
  if (state.guideTotal >= GUIDE_LIMITS.total) return false;

  if (dedupe) state.guided.add(key);
  state.guides[kind] = (state.guides[kind] ?? 0) + 1;
  state.guideTotal += 1;
  return true;
}

/**
 * Inject one hidden guidance note as an `aside`, which lands at the next agent
 * step boundary and never interrupts the tool batch it describes. The note is
 * agent-attributed and hidden because the plugin wrote it, not the user.
 *
 * Nothing here throws: a guidance note that cannot be delivered is not worth
 * failing a tool call over, and the caller is inside a handler whose throw would
 * be worse than a lost note.
 */
function sendGuidance(pi: ExtensionAPI, state: SessionState, kind: string, key: string, content: string): void {
  try {
    if (!claimGuidance(state, kind, key)) return;
    pi.sendMessage(
      { customType: `${GUIDANCE_TYPE}${kind}`, content, display: false, attribution: "agent" },
      { deliverAs: "aside", triggerTurn: false },
    );
  } catch {
    // A guidance note is best effort.
  }
}

/**
 * The routing note a local search earns. It recognizes the search the model is
 * about to run and says which graph call answers the same question; it never
 * refuses or rewrites the call, because a wrong guess about coverage must not
 * cost the model its search.
 */
function guideSearch(pi: ExtensionAPI, state: SessionState, toolName: unknown, input: unknown): void {
  if (!augmentEnabled(process.env, "search")) return;
  // Silent until a Symvanta init result showed this checkout attached: a
  // user-wide install must not send routing advice about an unindexed tree.
  if (state.attached !== true) return;

  const target = searchTarget(toolName, input);
  if (target === null) return;
  // The scope is part of the key: the same pattern searched in two trees is two
  // searches, and the same scope with a new pattern is a new question.
  const key = guideKey("search", `${target.tool}:${target.scope ?? "-"}:${target.query}`);
  sendGuidance(pi, state, "search", key, searchGuidance(target));
}

/** The routing note the first read of a code file earns: list_file_symbols, and adr with it. */
function guideRead(pi: ExtensionAPI, state: SessionState, toolName: unknown, input: unknown, cwd: string): void {
  if (!augmentEnabled(process.env, "read")) return;
  if (state.attached !== true) return;
  if (typeof toolName !== "string" || toolName.trim().toLowerCase() !== READ_TOOL) return;

  const target = readTarget(input, cwd);
  if (target === null) return;
  sendGuidance(pi, state, "read", guideKey("read", target), readGuidance(path.relative(cwd, target) || target));
}

/**
 * The rescue note an empty, successful grep earns. `grep` reports an empty page
 * as `matchCount: 0` in its details and as `No matches found` in its text, so
 * both are read; a `No more results` page is a page past the end of a search
 * that did match, and is deliberately not treated as empty.
 */
function guideRescue(pi: ExtensionAPI, state: SessionState, event: Record<string, unknown>): void {
  if (!augmentEnabled(process.env, "rescue")) return;
  if (state.attached !== true) return;
  if (typeof event.toolName !== "string" || event.toolName.trim().toLowerCase() !== GREP_TOOL) return;
  if (event.isError === true || typeof event.error === "string") return;

  const details = eventRecord(event.details);
  const blocks = Array.isArray(event.content) ? event.content : [];
  const body = blocks
    .map((block) => String(eventRecord(block).text ?? ""))
    .join("\n");

  // A page past the end of a search that did match reports `matchCount: 0` for
  // the page it returned, so the pagination notice is checked first and wins
  // over the count: that search found something, it is just on an earlier page.
  if (/^\s*No more results\b/.test(body)) return;
  if (details.matchCount !== 0 && !/^\s*No matches found\b/.test(body)) return;

  const input = eventRecord(event.input);
  const pattern = typeof input.pattern === "string" ? input.pattern : "";
  sendGuidance(pi, state, "rescue", guideKey("rescue", pattern), rescueGuidance(pattern));
}

/**
 * Publish the status one Symvanta result justified: the footer status, plus the
 * compact widget under the editor. Both carry the same key, so a later result
 * replaces the earlier one instead of stacking. In a headless or stubbed mode
 * the setters are absent or inert, which is why every call is optional and
 * wrapped: a missing status line is never worth failing a tool result over.
 */
function publishStatus(ctx: HandlerContext, status: { text: string | null; lines: string[] }): void {
  const ui = ctx.ui;
  if (!ui) return;
  try {
    if (status.text !== null && typeof ui.setStatus === "function") ui.setStatus(STATUS_KEY, status.text);
    if (status.lines.length > 0 && typeof ui.setWidget === "function") {
      ui.setWidget(STATUS_KEY, status.lines, { placement: STATUS_PLACEMENT });
    }
  } catch {
    // The status line is observation only.
  }
}

/** Drop this plugin's status and widget, so a new session never shows the last one's index. */
function clearStatus(ctx: HandlerContext): void {
  const ui = ctx.ui;
  if (!ui) return;
  try {
    if (typeof ui.setStatus === "function") ui.setStatus(STATUS_KEY, undefined);
    if (typeof ui.setWidget === "function") ui.setWidget(STATUS_KEY, undefined);
  } catch {
    // Nothing to clear.
  }
}

/**
 * Register the twelve documented `/symvanta-*` commands.
 *
 * A markdown file under `commands/` is a plugin file command, and a marketplace
 * install hands those to OMP's namespace rewriting, so the documented
 * `/symvanta-blast` would only be reachable as `/symvanta:symvanta-blast`. An
 * extension-registered command keeps the name it was registered with in every
 * install shape, so these twelve are registered here and render the same
 * templates, which keeps one source of instruction text and two names for it.
 *
 * The template is read lazily, on the first invocation, from the plugin's own
 * `commands/` directory, and the built-in body stands in when it cannot be
 * read. Registration at load touches no disk and cannot fail the session: a
 * command that could not register is logged and skipped.
 */
function registerCommands(pi: ExtensionAPI): void {
  const directory = commandDirectory(import.meta.url);
  for (const [name, command] of Object.entries(SYMVANTA_COMMANDS)) {
    try {
      pi.registerCommand(name, {
        description: command.description,
        async handler(args: string, ctx: unknown) {
          try {
            const text = renderCommandTemplate(loadCommandTemplate(name, directory), args);
            // User-attributed: the command's own text is what the user asked
            // for, and the transcript should read as if they typed it.
            await pi.sendUserMessage(text, { attribution: "user" });
          } catch (error) {
            pi.logger?.warn?.(`symvanta: ${name} did not dispatch: ${String(error)}`);
            try {
              (ctx as HandlerContext | undefined)?.ui?.notify?.(`Symvanta ${name} could not be sent.`, "warning");
            } catch {
              // The notification is best effort.
            }
          }
        },
      });
    } catch (error) {
      pi.logger?.warn?.(`symvanta: ${name} not registered: ${String(error)}`);
    }
  }
}

/**
 * Queues the hidden repository primer for the next user prompt. It goes out
 * even when git is unavailable, missing, or slow: the unbound branch of
 * buildStartupContext is itself the right instruction, and a failed read must
 * never delay or fail a session.
 */
async function queueRepositoryPrimer(pi: ExtensionAPI, cwd: string): Promise<void> {
  let primer: string;
  try {
    primer = buildStartupContext(await readCheckout(cwd));
  } catch {
    primer = buildStartupContext({});
  }

  try {
    // Hidden (display: false) and agent-attributed: this is context the plugin
    // generated, not something the user typed. nextTurn queues it for the next
    // user prompt without starting a turn of its own.
    pi.sendMessage(
      { customType: "symvanta.repository", content: primer, display: false, attribution: "agent" },
      { deliverAs: "nextTurn", triggerTurn: false },
    );
  } catch (error) {
    pi.logger?.warn?.(`symvanta: start context not queued: ${String(error)}`);
  }
}

/**
 * Fresh-session routine: last session's status dropped, guard state over,
 * primer queued. Shared by `session_start` and `/new`.
 *
 * The status is cleared unconditionally, before anything else. `/new` can hand
 * this transcript a new session id, so a "was published" flag kept under the old
 * id says nothing about what the UI is still showing: the widget from the
 * previous session would stay on screen. Clearing is two no-op-safe calls, so
 * the cheap unconditional path is also the correct one.
 */
async function initializeSession(pi: ExtensionAPI, ctx: HandlerContext): Promise<void> {
  clearStatus(ctx);
  resetSessionState(pi, ctx);
  await queueRepositoryPrimer(pi, ctx.cwd ?? process.cwd());
}

/** Whether a `session_switch` event started a new session (`/new`) rather than loading one. */
function isNewSessionSwitch(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const reason = (event as Record<string, unknown>).reason;
  return typeof reason === "string" && reason.trim().toLowerCase() === "new";
}

export default function symvantaPlugin(pi: ExtensionAPI) {
  pi.setLabel("Symvanta");

  // Registered at load, from the bundled templates: this is the one place the
  // documented `/symvanta-*` names are guaranteed to survive, because a
  // marketplace install rewrites the names of file commands but not these.
  registerCommands(pi);

  pi.on("session_start", async (_event, ctx) => {
    await initializeSession(pi, ctx as HandlerContext);
  });

  pi.on("session_switch", async (event, ctx) => {
    // `/new` swaps in an empty transcript inside the same process and emits
    // only this event, so without this branch a fresh session would get neither
    // the primer nor a clean guard: the previous session's satisfaction would
    // still stand. Resume, fork, and plain switches carry the transcript they
    // loaded, so nothing is reissued for them.
    if (!isNewSessionSwitch(event)) return;
    await initializeSession(pi, ctx as HandlerContext);
  });

  pi.on("before_agent_start", (event, ctx) => {
    // Guidance only, and additive: the prompt is not rewritten, the tools are
    // not narrowed, and the note goes back as a hidden companion message that
    // never reaches the transcript. The delivery is the returned message, not a
    // queued aside, because this hook is the one place the note belongs to the
    // submission it was read from.
    //
    // Deterministic on purpose, with no dedupe and no budget: OMP can run this
    // hook again for the same submission after a source-base change and keeps
    // only the accepted attempt's message, so a note claimed by a discarded
    // attempt would be lost. Firing once per prompt, and once per queued batch
    // of user work, is the bound instead.
    try {
      if (!augmentEnabled(process.env, "prompt")) return;
      const state = stateFor(ctx as HandlerContext);
      // Silent until an init result has shown this checkout attached.
      if (state.attached !== true) return;
      const terms = extractPromptTerms(eventRecord(event).prompt);
      if (terms.length === 0) return;

      const content = promptGuidance(terms);
      return { message: { customType: `${GUIDANCE_TYPE}prompt`, content, display: false, attribution: "agent" } };
    } catch {
      return;
    }
  });

  pi.on("tool_call", (event, ctx) => {
    // Fail open by construction: a throw from a tool_call handler blocks the
    // tool, so every branch below is inside this try/catch and any surprise ends
    // in "no opinion".
    try {
      const report = eventRecord(event);
      const state = stateFor(ctx as HandlerContext);
      const invocation = logicalInvocation(report.toolName, report.input);

      // A Symvanta call never mutates a file, whichever transport carried it,
      // and only the impact check is recorded: in flight, keyed by the outer
      // tool call id, and nothing else. It does not satisfy the guard yet. OMP
      // fires `tool_call` for every call in a model batch before running any of
      // them, so an edit scheduled beside this check reaches its own `tool_call`
      // while the check has not run: only `tool_result` may open the gate.
      if (invocation !== null) {
        // A device call that answered docs, or whose content was absent or
        // malformed, never reached the tool, so it is not a check: the outer
        // write's success says nothing about the graph. Only an executable
        // impact check is recorded.
        if (invocation.executable && isImpactCheckCall(invocation.tool, invocation.input)) {
          const callId = toolCallIdOf(event);
          if (callId !== null) state.pendingImpact.add(callId);
        }
        return;
      }

      const toolName = report.toolName;
      const input = report.input;
      if (typeof toolName !== "string" || !Object.hasOwn(EDIT_TOOLS, toolName)) {
        // Everything that is not a mutation is a chance to route a search or a
        // read through the graph. Both are advice, and neither changes the call.
        guideSearch(pi, state, toolName, input);
        guideRead(pi, state, toolName, input, ctx.cwd ?? process.cwd());
        return;
      }
      if (state.impactMode === "off") return;
      // Silent until a Symvanta init result has shown this checkout attached,
      // which is what "unattached" means for a user-wide install. An impact
      // check that already succeeded is the exception: the model asked for it
      // explicitly, so the gate is open whatever the status widget believes.
      if (state.attached !== true && !state.impactObserved) return;
      // The gate: satisfied, or already refused as often as this mode allows.
      // `once` stops at MAX_GUARD_BLOCKS and fails open; `strict` never does.
      // `warn` refuses nothing, so it never stops here and advises below.
      if (state.impactObserved || (impactBlocks(state.impactMode) && state.blocks >= impactBlockLimit(state.impactMode, MAX_GUARD_BLOCKS))) return;

      // Availability is probed per session and re-probed lazily, so an MCP
      // reload that connects Symvanta mid-session still arms the guard, and a
      // session without Symvanta tools never blocks anything.
      if (!state.hasImpactTool) {
        state.tools = findSymvantaTools(pi);
        state.hasImpactTool = state.tools.relate || state.tools.estimateScope;
        if (!state.hasImpactTool) return;
      }

      const cwd = ctx.cwd ?? process.cwd();
      const target = gatedTarget(input, cwd);
      if (target === null) return;

      const relative = path.relative(cwd, target) || target;
      if (!impactBlocks(state.impactMode)) {
        // `warn`: the mutation runs, and the note beside it says which check
        // would have covered it. Captured per file so a batch of edits to one
        // file is advised once.
        sendGuidance(pi, state, "warn", guideKey("warn", relative), warnGuidance(relative, state.tools));
        return;
      }

      state.blocks += 1;
      const reason = blockReason(relative, state.tools, state.impactMode);
      if (ctx.hasUI) {
        try {
          ctx.ui.notify(`Symvanta impact guard refused an edit to ${relative}: run an impact check first.`, "warning");
        } catch {
          // A notification is best effort; the refusal itself is what matters.
        }
      }
      return { block: true, reason };
    } catch {
      return;
    }
  });

  pi.on("tool_result", (event, ctx) => {
    // Three things happen here, and none of them patches the result:
    // satisfaction is decided, the status widget is fed, and an empty search is
    // rescued. Satisfaction is decided here and nowhere else: the gate opens
    // only for an impact check that actually completed successfully, so a check
    // that is still running, or one that failed, leaves it shut.
    try {
      const record = eventRecord(event);
      const handlerContext = ctx as HandlerContext;
      const state = stateFor(handlerContext);
      const callId = toolCallIdOf(event);
      const invocation = logicalInvocation(record.toolName, record.input, record.details);
      // Executable only: a docs answer and a malformed device payload both
      // complete without the Symvanta tool running, and a result whose xdev
      // metadata says `mode: "help"` did not run it either. None of them may
      // satisfy the guard, move the status, or arm a tool, however successful
      // the outer write looks.
      const call = invocation !== null && invocation.executable ? invocation : null;
      // Matching the id pairs this result with the check this session issued.
      // The identity test is the fallback for a check whose `tool_call` this
      // module never saw (a call already in flight when the extension loaded).
      const pending = callId !== null && state.pendingImpact.delete(callId);
      const failed = record.isError === true || typeof record.error === "string";
      if (!failed && call !== null && (pending || isImpactCheckCall(call.tool, call.input))) {
        state.impactObserved = true;
      }

      // The status widget reads only the three tools that describe the index,
      // and only when the call succeeded; a failed or unrecognized result
      // changes nothing, so the last real observation stays on screen. An
      // `init` result also carries what it observed about attachment, which is
      // what opens the augmenters and the guard for this session.
      const status = statusFromToolResult(call === null ? null : call.tool, record);
      if (status !== null) {
        if (status.attached !== null) state.attached = status.attached;
        publishStatus(handlerContext, status);
      }

      // A successful bridged `init` proves the Symvanta server is answering in
      // this session, and in a device-based harness that is the only proof
      // there is: the MCP tools are reached through `write` to `xd://` paths
      // and are not on `getAllTools()` at all, so without this the guard would
      // find no impact tool to arm with. `relate` and `estimate_scope` are the
      // pair the guard offers, so they are the pair marked available.
      if (!failed && call !== null && call.bridged && call.tool === "init") {
        state.tools = { relate: true, estimateScope: true };
        state.hasImpactTool = true;
      }

      guideRescue(pi, state, record);
    } catch {
      return;
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    try {
      const key = sessionKey(ctx as HandlerContext);
      sessions.get(key)?.pendingImpact.clear();
      sessions.delete(key);
    } catch {
      // Nothing to clean up.
    }
  });
}
