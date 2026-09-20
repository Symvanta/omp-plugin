// Behavioral tests for the extension module (src/index.ts), driven through a
// dependency-free fake ExtensionAPI: no host, no MCP server, no network.
//
// The fake records what the extension registers (events, commands) and does
// (messages, asides, UI calls), so each test asserts an observable contract:
// the impact modes and what opens the gate, the observation-only status widget,
// the guidance-only augmenters and their per-session dedupe, the stable command
// aliases, and the fresh-session and shutdown resets. The module is imported
// directly; Node 22 runs the TypeScript through its built-in type stripping, so
// there is no build step and no dependency to install.
//
// Node built-ins only, run with `node --test`.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import symvantaPlugin from "../src/index.ts";
import { IMPACT_MODES, impactBlockLimit, isOffValue, parseImpactMode } from "../src/impact.js";
import { AUGMENT_FEATURES, augmentEnabled, extractPromptTerms, guideKey, searchTarget } from "../src/augment.js";
import { STATUS_TOOL_NAMES, statusFromToolResult } from "../src/status.js";
import { SYMVANTA_COMMANDS, renderCommandTemplate } from "../src/commands.js";

/** The documented command set: the twelve stable `/symvanta-*` names. */
const DOCUMENTED_COMMANDS = [
  "symvanta-ask",
  "symvanta-architecture",
  "symvanta-blast",
  "symvanta-branch",
  "symvanta-clear",
  "symvanta-recent",
  "symvanta-route",
  "symvanta-scope",
  "symvanta-status",
  "symvanta-tests",
  "symvanta-trace",
  "symvanta-working-tree",
];

const SWITCH_KEYS = [
  "SYMVANTA_IMPACT_MODE",
  "SYMVANTA_AUGMENT",
  "SYMVANTA_AUGMENT_PROMPT",
  "SYMVANTA_AUGMENT_SEARCH",
  "SYMVANTA_AUGMENT_READ",
  "SYMVANTA_AUGMENT_RESCUE",
  "SYMVANTA_AUGMENT_DEDUPE",
];

const STATUS_KEY = "symvanta";
const GUIDANCE_PREFIX = "symvanta.guidance.";

/** Symvanta tools as the host exposes them: an MCP server name plus the bare tool name. */
const SYMVANTA_TOOL_DEFS = [
  { name: "mcp__symvanta_relate", mcpServerName: "symvanta", mcpToolName: "relate" },
  { name: "mcp__symvanta_estimate_scope", mcpServerName: "symvanta", mcpToolName: "estimate_scope" },
  { name: "mcp__symvanta_init", mcpServerName: "symvanta", mcpToolName: "init" },
];

let workspace;
let sessionSeq = 0;

before(() => {
  workspace = mkdtempSync(join(tmpdir(), "symvanta-plugin-"));
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "app.ts"), "export const app = 1;\n");
  writeFileSync(join(workspace, "src", "other.ts"), "export const other = 2;\n");
  writeFileSync(join(workspace, "README.md"), "# fixture\n");
});

after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

// --------------------------------------------------------------------- helpers

function nextSessionId() {
  sessionSeq += 1;
  return `session-${sessionSeq}`;
}

/** Run `body` with exactly the given switch values set, then restore the environment. */
async function withSwitches(overrides, body) {
  const saved = new Map(SWITCH_KEYS.map((key) => [key, process.env[key]]));
  const values = Object.fromEntries(SWITCH_KEYS.map((key) => [key, overrides[key]]));
  for (const key of SWITCH_KEYS) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  try {
    return await body();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/**
 * A fresh extension instance wired to a recording fake. Every harness gets its
 * own session id, because the module keeps session state in a process-wide map.
 */
function harness({ tools = SYMVANTA_TOOL_DEFS, sessionId = nextSessionId() } = {}) {
  const handlers = new Map();
  const messages = [];
  const userMessages = [];
  const commands = new Map();
  const widgets = [];
  const statuses = [];
  const notifications = [];
  const warnings = [];

  const pi = {
    setLabel() {},
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerCommand(name, definition) {
      commands.set(name, definition);
    },
    getAllTools() {
      return tools;
    },
    sendMessage(payload, options) {
      messages.push({ payload, options });
    },
    sendUserMessage(content, options) {
      userMessages.push({ content, options });
    },
    logger: { warn: (message) => warnings.push(String(message)) },
  };

  const ui = {
    notify: (message, level) => notifications.push({ message, level }),
    setStatus: (key, text) => statuses.push({ key, text }),
    setWidget: (key, content, options) => widgets.push({ key, content, options }),
  };

  let currentSessionId = sessionId;
  const ctx = {
    cwd: workspace,
    hasUI: true,
    ui,
    sessionManager: { getSessionId: () => currentSessionId },
  };
  const setSessionId = (next) => {
    currentSessionId = next;
  };

  symvantaPlugin(pi);

  const emit = async (event, payload) => {
    const list = handlers.get(event) ?? [];
    const results = [];
    for (const handler of list) results.push(await handler(payload, ctx));
    return results;
  };

  const first = async (event, payload) => (await emit(event, payload))[0];

  /**
   * The observation that arms the gated features: a successful `init` result
   * whose workspace reports whether this checkout is attached. Until one arrives
   * the impact guard and the guidance augmenters stay silent; the status widget
   * still mirrors what the result said.
   */
  const attach = async (attached = true) => {
    await emit("tool_result", {
      toolCallId: `attach-${sessionId}`,
      toolName: "mcp__symvanta_init",
      input: {},
      isError: false,
      details: { workspace: { repository: "Symvanta/omp-plugin", attached } },
    });
  };

  /**
   * A fresh session, attached unless the test wants the unobserved state
   * (`{ attached: null }` starts the session without an init observation).
   */
  const start = async ({ attached = true } = {}) => {
    await emit("session_start", {});
    if (attached !== null) await attach(attached);
  };

  const asides = () => messages.filter((entry) => entry.options?.deliverAs === "aside");
  const guidance = (kind) => asides().filter((entry) => entry.payload.customType === `${GUIDANCE_PREFIX}${kind}`);
  const statusWrites = () => statuses.filter((entry) => entry.text !== undefined);
  const statusClears = () => statuses.filter((entry) => entry.text === undefined);
  const widgetWrites = () => widgets.filter((entry) => entry.content !== undefined);
  const widgetClears = () => widgets.filter((entry) => entry.content === undefined);

  return {
    pi,
    ctx,
    sessionId,
    setSessionId,
    handlers,
    messages,
    userMessages,
    commands,
    widgets,
    statuses,
    notifications,
    warnings,
    emit,
    first,
    attach,
    start,
    asides,
    guidance,
    statusWrites,
    statusClears,
    widgetWrites,
    widgetClears,
  };
}

/** The Symvanta tool_result payload for one tool call. */
function symvantaResult(toolName, { callId = "call-1", details, isError = false, content } = {}) {
  return { toolCallId: callId, toolName: `mcp__symvanta_${toolName}`, input: {}, details, isError, content };
}

const EDIT_APP = { path: "src/app.ts", content: "export const app = 2;\n" };
const EDIT_OTHER = { path: "src/other.ts", content: "export const other = 3;\n" };

// ------------------------------------------------------------ pure switch parsing

test("parseImpactMode reads the documented modes and selects once for a missing, empty, or invalid value", () => {
  assert.deepEqual([...IMPACT_MODES], ["once", "strict", "warn", "off"]);

  assert.equal(parseImpactMode({}), "once", "the default is once");
  assert.equal(parseImpactMode(undefined), "once", "a missing environment is the default");
  assert.equal(parseImpactMode({ SYMVANTA_IMPACT_MODE: "" }), "once", "an empty value selects once");
  assert.equal(parseImpactMode({ SYMVANTA_IMPACT_MODE: "   " }), "once", "a blank value selects once");
  assert.equal(parseImpactMode({ SYMVANTA_IMPACT_MODE: "sometimes" }), "once", "an unknown value selects once");
  for (const mode of ["once", "strict", "warn", "off"]) {
    assert.equal(parseImpactMode({ SYMVANTA_IMPACT_MODE: mode }), mode, `the ${mode} mode is read`);
  }
  assert.equal(parseImpactMode({ SYMVANTA_IMPACT_MODE: "  WARN " }), "warn", "values are trimmed and case-insensitive");
  assert.ok(isOffValue("NO"));
  assert.ok(!isOffValue("on"));
  assert.equal(impactBlockLimit("once", 1), 1);
  assert.equal(impactBlockLimit("strict", 1), Number.POSITIVE_INFINITY, "strict never fails open");
  assert.equal(impactBlockLimit("warn", 1), 0);
  assert.equal(impactBlockLimit("off", 1), 0);
});

test("augmentEnabled honors the global switch, the per-feature switch, and dedupe", () => {
  assert.deepEqual([...AUGMENT_FEATURES], ["prompt", "search", "read", "rescue", "dedupe"]);

  for (const feature of ["prompt", "search", "read", "rescue", "dedupe"]) {
    assert.ok(augmentEnabled({}, feature), `${feature} is on by default`);
    assert.ok(!augmentEnabled({ SYMVANTA_AUGMENT: "off" }, feature), "the global switch disables every feature");
  }
  assert.ok(!augmentEnabled({ SYMVANTA_AUGMENT_SEARCH: "0" }, "search"), "a per-feature switch disables one feature");
  assert.ok(augmentEnabled({ SYMVANTA_AUGMENT_SEARCH: "0" }, "read"), "a per-feature switch leaves the others on");
  assert.ok(!augmentEnabled({ SYMVANTA_AUGMENT_DEDUPE: "no" }, "dedupe"), "dedupe has its own switch");
  assert.ok(!augmentEnabled({}, "unknown-feature"), "an unknown feature never runs");
});

test("guidance helpers recognize searches and identifiers without inventing any", () => {
  assert.deepEqual(searchTarget("grep", { pattern: "primer" }), { tool: "grep", query: "primer", scope: null });
  assert.deepEqual(searchTarget("grep", { pattern: "primer", path: "src" }), { tool: "grep", query: "primer", scope: "src" });
  assert.deepEqual(searchTarget("glob", { path: "**/*.ts" }), { tool: "glob", query: "**/*.ts", scope: null });
  assert.equal(searchTarget("grep", {}), null, "a search without a pattern names nothing");
  assert.equal(searchTarget("glob", { pattern: "*.ts" }), null, "the glob pattern is its path field");
  assert.equal(searchTarget("read", { path: "src/app.ts" }), null, "a read is not a search");
  assert.deepEqual(searchTarget("bash", { command: "rg -n primer src" }).tool, "bash");
  assert.equal(searchTarget("bash", { command: "npm test" }), null, "an ordinary command is not a code search");
  assert.equal(searchTarget("bash", { command: "find . -name '*.ts'" }).tool, "bash", "a find command counts");
  assert.equal(searchTarget("bash", { command: "grepable thing" }), null, "a substring of a command word does not count");

  assert.deepEqual(extractPromptTerms("how does `normalizeAlias` treat parseGitHubRemote?"), [
    "normalizeAlias",
    "parseGitHubRemote",
  ]);
  assert.deepEqual(extractPromptTerms("fix the failing test"), [], "prose is not a symbol");
  assert.deepEqual(extractPromptTerms(""), [], "an empty prompt names nothing");

  assert.equal(guideKey("search", "  MyQuery "), "search:myquery", "keys are normalized so a repeat dedupes");
});

test("statusFromToolResult mirrors only the three index-describing tools", () => {
  assert.deepEqual([...STATUS_TOOL_NAMES], ["init", "freshness", "index_health"]);

  const init = statusFromToolResult("init", {
    details: { workspace: { repository: "Symvanta/omp-plugin", attached: true }, project: { name: "omp-plugin" }, repositories: [{}, {}] },
  });
  assert.ok(init.lines.length > 0);
  assert.match(init.text, /^symvanta: omp-plugin · attached$/);

  const freshness = statusFromToolResult("freshness", {
    details: {
      repository: { fullName: "Symvanta/omp-plugin" },
      lastIndexedSha: "abcdef1234",
      currentRemoteSha: "abcdef1234",
      isStale: false,
    },
  });
  assert.match(freshness.text, /^symvanta: omp-plugin · fresh$/);
  assert.ok(freshness.lines.some((line) => line.includes("indexed abcdef1")));

  const health = statusFromToolResult("index_health", { details: { degradedRepositories: [{}], pendingLibraryVersions: [{}] } });
  assert.match(health.text, /^symvanta: 1 degraded$/);

  assert.equal(statusFromToolResult("relate", { details: { workspace: { repository: "x" } } }), null, "only the three tools feed it");
  assert.equal(statusFromToolResult("init", { details: {} }), null, "a payload it cannot read produces nothing");
});

// ------------------------------------------------------------------- commands

test("the extension registers every documented command alias", () => {
  const app = harness();
  assert.deepEqual([...app.commands.keys()].sort(), [...DOCUMENTED_COMMANDS].sort());
  assert.deepEqual(Object.keys(SYMVANTA_COMMANDS).sort(), [...DOCUMENTED_COMMANDS].sort(), "the shipped table matches the contract");
  for (const command of DOCUMENTED_COMMANDS) {
    assert.ok(app.commands.get(command).description.length > 0, `${command} needs a description`);
  }
});

test("an invoked alias sends the rendered template with the user's arguments", () => {
  const app = harness();
  const definition = app.commands.get("symvanta-blast");
  return definition.handler("parseGitHubRemote", app.ctx).then(() => {
    assert.equal(app.userMessages.length, 1);
    const [message] = app.userMessages;
    assert.match(message.content, /parseGitHubRemote/, "the argument must reach the template");
    assert.doesNotMatch(message.content, /\$ARGUMENTS|\$@/, "the placeholder must be expanded");
    assert.equal(message.options.attribution, "user", "the command text reads as the user's own prompt");
    assert.equal(renderCommandTemplate("Look up $ARGUMENTS now", "x").includes("$ARGUMENTS"), false);
    assert.ok(SYMVANTA_COMMANDS["symvanta-blast"].fallback.includes("$ARGUMENTS"), "the fallback keeps its placeholder");
  });
});

test("command arguments are inserted literally, not as replacement patterns", async () => {
  const args = "sed 's/$1/x/;s/$&/y/' $` $' $$ and $@";
  assert.equal(
    renderCommandTemplate("Run $ARGUMENTS and $@ on the target.", args),
    `Run ${args} and ${args} on the target.`,
    "the argument text is never a replacement pattern",
  );
  assert.equal(
    renderCommandTemplate("Ask: $ARGUMENTS", "keep $ARGUMENTS and $@ literal"),
    "Ask: keep $ARGUMENTS and $@ literal",
    "one replace pass must not rescan the inserted argument",
  );
  assert.equal(
    renderCommandTemplate("read $@[1] please", "x"),
    "read $@[1] please\n\nx",
    "$@[1] is not an aggregate, so the raw argument is appended",
  );

  const app = harness();
  await app.commands.get("symvanta-blast").handler(args, app.ctx);
  assert.ok(app.userMessages[0].content.includes(args), "the command sends the argument text verbatim");
});

// ------------------------------------------------------------------- impact modes

test("the default mode refuses the first existing-code edit, then fails open", async () => {
  await withSwitches({}, async () => {
    const app = harness();
    await app.start();

    const [blocked] = await app.emit("tool_call", { toolName: "edit", input: EDIT_APP, toolCallId: "e1" });
    assert.equal(blocked?.block, true, "the first edit of existing code is refused");
    assert.match(blocked.reason, /blast_radius|estimate_scope/, "the refusal must name a real check");
    assert.ok(app.notifications.some((entry) => /refused/.test(entry.message)), "the refusal is surfaced to the user");

    const [second] = await app.emit("tool_call", { toolName: "edit", input: EDIT_APP, toolCallId: "e2" });
    assert.equal(second, undefined, "once refuses at most one edit per session");
  });
});

test("a successfully completed impact check opens the gate, but a pending one does not", async () => {
  await withSwitches({}, async () => {
    const app = harness();
    await app.start();

    // The check is issued in the same model batch as the edit: it is in flight,
    // not completed, so the edit must still be refused.
    const [check] = await app.emit("tool_call", {
      toolName: "mcp__symvanta_relate",
      input: { kind: "blast_radius", symbol: "app" },
      toolCallId: "c1",
    });
    assert.equal(check, undefined, "the check itself passes untouched");

    const [blocked] = await app.emit("tool_call", { toolName: "edit", input: EDIT_APP, toolCallId: "e1" });
    assert.equal(blocked?.block, true, "an in-flight check must not wave the edit through");

    await app.emit("tool_result", {
      toolCallId: "c1",
      toolName: "mcp__symvanta_relate",
      input: { kind: "blast_radius" },
      isError: false,
      content: [{ type: "text", text: "ok" }],
    });

    const [allowed] = await app.emit("tool_call", { toolName: "edit", input: EDIT_APP, toolCallId: "e2" });
    assert.equal(allowed, undefined, "a completed check opens the gate for the session");
  });
});

test("a failed or unrecognized check never opens the gate", async () => {
  await withSwitches({ SYMVANTA_IMPACT_MODE: "strict" }, async () => {
    const app = harness();
    await app.start();

    await app.emit("tool_call", { toolName: "mcp__symvanta_estimate_scope", input: { task: "x" }, toolCallId: "c1" });
    await app.emit("tool_result", {
      toolCallId: "c1",
      toolName: "mcp__symvanta_estimate_scope",
      input: { task: "x" },
      isError: true,
      error: "server down",
    });

    const [blocked] = await app.emit("tool_call", { toolName: "edit", input: EDIT_APP, toolCallId: "e1" });
    assert.equal(blocked?.block, true, "a failed check leaves the gate shut");

    const [alsoBlocked] = await app.emit("tool_call", { toolName: "edit", input: EDIT_APP, toolCallId: "e2" });
    assert.equal(alsoBlocked?.block, true, "strict keeps refusing instead of failing open");
    assert.match(alsoBlocked.reason, /strict/, "the refusal explains the mode");
  });
});

test("warn mode advises instead of refusing, once per file", async () => {
  await withSwitches({ SYMVANTA_IMPACT_MODE: "warn" }, async () => {
    const app = harness();
    await app.start();

    const [allowed] = await app.emit("tool_call", { toolName: "edit", input: EDIT_APP, toolCallId: "e1" });
    assert.equal(allowed, undefined, "warn never blocks");
    assert.deepEqual(app.notifications, [], "warn does not raise a refusal notification");

    const warn = app.guidance("warn");
    assert.equal(warn.length, 1, "the unchecked edit earns one advisory note");
    assert.match(warn[0].payload.content, /blast_radius|estimate_scope/);
    assert.equal(warn[0].payload.display, false, "the advisory is not shown as a user message");

    await app.emit("tool_call", { toolName: "edit", input: EDIT_APP, toolCallId: "e2" });
    assert.equal(app.guidance("warn").length, 1, "a second edit of the same file is not advised twice");

    await app.emit("tool_call", { toolName: "edit", input: EDIT_OTHER, toolCallId: "e3" });
    assert.equal(app.guidance("warn").length, 2, "a different file earns its own advisory");
  });
});

test("off mode refuses nothing and says nothing", async () => {
  await withSwitches({ SYMVANTA_IMPACT_MODE: "off" }, async () => {
    const app = harness();
    await app.start();
    const [allowed] = await app.emit("tool_call", { toolName: "edit", input: EDIT_APP, toolCallId: "e1" });
    assert.equal(allowed, undefined);
    assert.deepEqual(app.asides(), [], "off injects no advisory");
    assert.deepEqual(app.notifications, []);
  });

  // A value that names no mode selects once, so the guard is still armed.
  for (const declared of ["", "  ", "sometimes"]) {
    await withSwitches({ SYMVANTA_IMPACT_MODE: declared }, async () => {
      const app = harness();
      await app.start();
      const [blocked] = await app.emit("tool_call", { toolName: "edit", input: EDIT_APP, toolCallId: "e1" });
      assert.equal(blocked?.block, true, `"${declared}" selects once, which refuses the first write`);
    });
  }
});

test("the gate fails open when the graph is unreachable, and passes new or non-code files", async () => {
  await withSwitches({ SYMVANTA_IMPACT_MODE: "strict" }, async () => {
    const app = harness({ tools: [] });
    await app.start();
    const [allowed] = await app.emit("tool_call", { toolName: "edit", input: EDIT_APP, toolCallId: "e1" });
    assert.equal(allowed, undefined, "no Symvanta tools means no gating");
  });

  await withSwitches({ SYMVANTA_IMPACT_MODE: "strict" }, async () => {
    const app = harness();
    await app.start();
    const [created] = await app.emit("tool_call", { toolName: "write", input: { path: "src/brand-new.ts", content: "x" }, toolCallId: "e1" });
    assert.equal(created, undefined, "a new file is never gated");
    const [nonCode] = await app.emit("tool_call", { toolName: "edit", input: { path: "README.md", content: "x" }, toolCallId: "e2" });
    assert.equal(nonCode, undefined, "a non-code file is never gated");
  });
});

test("a new session re-arms the gate and the namespaced MCP wire names still count as the check", async () => {
  await withSwitches({}, async () => {
    const app = harness();
    await app.start();

    await app.emit("tool_call", { toolName: "mcp__symvanta_relate", input: { kind: "blast_radius" }, toolCallId: "c1" });
    await app.emit("tool_result", { toolCallId: "c1", toolName: "mcp__symvanta_relate", input: { kind: "blast_radius" } });
    const [allowed] = await app.emit("tool_call", { toolName: "edit", input: EDIT_APP, toolCallId: "e1" });
    assert.equal(allowed, undefined);

    await app.emit("session_switch", { reason: "new" });
    const primers = () => app.messages.filter((entry) => entry.payload.customType === "symvanta.repository").length;
    assert.equal(primers(), 2, "a new transcript is re-primed");
    await app.attach();
    const [rearmed] = await app.emit("tool_call", { toolName: "edit", input: EDIT_APP, toolCallId: "e2" });
    assert.equal(rearmed?.block, true, "a fresh transcript must not inherit the satisfied gate");

    // A plain switch loads the transcript it names, so nothing is reset.
    await app.emit("session_switch", { reason: "resume" });
    assert.equal(primers(), 2, "resume does not re-issue the primer");
  });
});

test("shutdown drops the session state", async () => {
  await withSwitches({}, async () => {
    const app = harness();
    await app.start();
    await app.emit("tool_call", { toolName: "mcp__symvanta_relate", input: { kind: "blast_radius" }, toolCallId: "c1" });
    await app.emit("tool_result", { toolCallId: "c1", toolName: "mcp__symvanta_relate", input: { kind: "blast_radius" } });

    await app.emit("session_shutdown", {});
    await app.attach();
    const [armed] = await app.emit("tool_call", { toolName: "edit", input: EDIT_APP, toolCallId: "e1" });
    assert.equal(armed?.block, true, "a new session in the same process starts armed");
  });
});

// ---------------------------------------------------------------- status widget

test("the status widget mirrors only successful init, freshness, and index_health results", async () => {
  await withSwitches({}, async () => {
    const app = harness();
    await app.emit("session_start", {});
    assert.deepEqual(app.statusWrites(), [], "no result has been observed yet");

    await app.emit("tool_result", { toolCallId: "r1", toolName: "bash", input: {}, details: { workspace: { repository: "x" } } });
    await app.emit("tool_result", symvantaResult("relate", { callId: "r2", details: { workspace: { repository: "x" } } }));
    assert.deepEqual(app.statusWrites(), [], "only the three index tools feed the status");

    await app.emit("tool_result", {
      ...symvantaResult("init", {
        callId: "r3",
        details: { workspace: { repository: "Symvanta/omp-plugin", attached: true }, project: { name: "omp-plugin" }, repositories: [{}] },
      }),
    });
    assert.equal(app.statusWrites().length, 1, "a successful init result publishes the status");
    assert.equal(app.statusWrites()[0].key, STATUS_KEY);
    assert.match(app.statusWrites()[0].text, /^symvanta: /);

    assert.equal(app.widgetWrites().length, 1, "the same result publishes the widget");
    assert.equal(app.widgetWrites()[0].key, STATUS_KEY);
    assert.ok(Array.isArray(app.widgetWrites()[0].content) && app.widgetWrites()[0].content.length > 0);
    assert.equal(app.widgetWrites()[0].options.placement, "belowEditor", "the widget sits under the editor");

    await app.emit("tool_result", {
      ...symvantaResult("freshness", {
        callId: "r4",
        details: { repository: "Symvanta/omp-plugin", lastIndexedSha: "abcdef1", currentRemoteSha: "abcdef1", isStale: true },
        isError: true,
      }),
    });
    assert.equal(app.statusWrites().length, 1, "a failed result changes nothing");

    await app.emit("tool_result", symvantaResult("index_health", { callId: "r5", details: { degradedRepositories: [{}] } }));
    assert.equal(app.statusWrites().length, 2, "a successful index_health result replaces the last observation");
    assert.match(app.statusWrites()[1].text, /degraded/);
  });
});

test("a new session clears the last session's status and widget", async () => {
  await withSwitches({}, async () => {
    const app = harness();
    await app.emit("session_start", {});
    await app.emit("tool_result", symvantaResult("init", { callId: "r1", details: { workspace: { repository: "Symvanta/omp-plugin" } } }));
    assert.equal(app.statusWrites().length, 1);
    const clearsBefore = app.statusClears().length;
    const widgetClearsBefore = app.widgetClears().length;

    await app.emit("session_switch", { reason: "new" });
    assert.equal(app.statusClears().length, clearsBefore + 1, "the footer is cleared for the new transcript");
    assert.equal(app.widgetClears().length, widgetClearsBefore + 1, "the widget is cleared for the new transcript");
    assert.equal(app.statusClears().at(-1).text, undefined);
    assert.equal(app.widgetClears().at(-1).content, undefined);
  });
});

test("a new session clears the previous status even when the session id changes", async () => {
  await withSwitches({}, async () => {
    const app = harness();
    await app.emit("session_start", {});
    await app.emit("tool_result", symvantaResult("init", { callId: "r1", details: { workspace: { repository: "Symvanta/omp-plugin", attached: true } } }));
    assert.equal(app.statusWrites().length, 1);
    const clearsBefore = app.statusClears().length;
    const widgetClearsBefore = app.widgetClears().length;

    // `/new` mints a new session id, so the state bucket is new; the UI the
    // previous transcript published still has to be cleared.
    app.setSessionId(`${app.sessionId}-next`);
    await app.emit("session_switch", { reason: "new" });
    assert.equal(app.statusClears().length, clearsBefore + 1, "the old footer is cleared from the new session's context");
    assert.equal(app.widgetClears().length, widgetClearsBefore + 1, "the old widget is cleared too");
    assert.equal(
      app.messages.filter((entry) => entry.payload.customType === "symvanta.repository").length,
      2,
      "the new transcript is still primed",
    );
  });
});

// -------------------------------------------------------------- prompt guidance

test("prompt guidance names the symbols a prompt mentions and repeats for the same submission", async () => {
  await withSwitches({}, async () => {
    const app = harness();
    await app.start();

    const [result] = await app.emit("before_agent_start", { prompt: "how does `normalizeAlias` differ from parseGitHubRemote?" });
    assert.ok(result?.message, "a symbol-shaped prompt earns a note");
    assert.equal(result.message.customType, `${GUIDANCE_PREFIX}prompt`);
    assert.equal(result.message.display, false, "the note is hidden");
    assert.equal(result.message.attribution, "agent");
    assert.match(result.message.content, /normalizeAlias/);
    assert.match(result.message.content, /not a graph result/, "the note must not claim it queried the graph");

    // OMP can run the whole hook chain again for one submission after a
    // source-base change and keeps only the accepted attempt, so the note is
    // deterministic rather than claimed: the retry must get the same message.
    const [repeat] = await app.emit("before_agent_start", { prompt: "how does `normalizeAlias` differ from parseGitHubRemote?" });
    assert.deepEqual(repeat, result, "a re-run of the same submission gets the same note");

    const [prose] = await app.emit("before_agent_start", { prompt: "fix the failing test please" });
    assert.equal(prose, undefined, "a prompt without a symbol earns nothing");
  });

  await withSwitches({ SYMVANTA_AUGMENT: "off" }, async () => {
    const app = harness();
    await app.start();
    const [result] = await app.emit("before_agent_start", { prompt: "how does `normalizeAlias` work?" });
    assert.equal(result, undefined, "the global switch disables the prompt augmenter");
  });

  await withSwitches({ SYMVANTA_AUGMENT_PROMPT: "off" }, async () => {
    const app = harness();
    await app.start();
    const [result] = await app.emit("before_agent_start", { prompt: "how does `normalizeAlias` work?" });
    assert.equal(result, undefined, "the per-feature switch disables the prompt augmenter");
  });
});

// ------------------------------------------------------------- search and read

test("local searches earn one aside each, deduped per session and never blocked", async () => {
  await withSwitches({}, async () => {
    const app = harness();
    await app.start();

    const [unblocked] = await app.emit("tool_call", { toolName: "grep", input: { pattern: "primer" }, toolCallId: "g1" });
    assert.equal(unblocked, undefined, "guidance never blocks or rewrites a call");

    const search = app.guidance("search");
    assert.equal(search.length, 1);
    assert.equal(search[0].options.deliverAs, "aside");
    assert.equal(search[0].options.triggerTurn, false);
    assert.match(search[0].payload.content, /locate/);
    assert.match(search[0].payload.content, /not a graph result/);

    await app.emit("tool_call", { toolName: "grep", input: { pattern: "primer" }, toolCallId: "g2" });
    assert.equal(app.guidance("search").length, 1, "a repeated search is not advised twice");

    await app.emit("tool_call", { toolName: "grep", input: { pattern: "other" }, toolCallId: "g3" });
    assert.equal(app.guidance("search").length, 2, "a new query earns its own note");

    await app.emit("tool_call", { toolName: "bash", input: { command: "rg -n primer src" }, toolCallId: "g4" });
    assert.equal(app.guidance("search").length, 3, "a shell search counts as a search");

    await app.emit("tool_call", { toolName: "bash", input: { command: "npm test" }, toolCallId: "g5" });
    assert.equal(app.guidance("search").length, 3, "an ordinary command earns nothing");

    await app.emit("tool_call", { toolName: "glob", input: { path: "**/*.ts" }, toolCallId: "g6" });
    assert.equal(app.guidance("search").length, 4);
    assert.match(app.guidance("search")[3].payload.content, /locate mode:file/, "a glob note names the file lookup");
  });

  await withSwitches({}, async () => {
    const first = harness();
    const second = harness();
    await first.start();
    await second.start();
    await first.emit("tool_call", { toolName: "grep", input: { pattern: "primer" }, toolCallId: "g1" });
    await second.emit("tool_call", { toolName: "grep", input: { pattern: "primer" }, toolCallId: "g1" });
    assert.equal(first.guidance("search").length, 1);
    assert.equal(second.guidance("search").length, 1, "dedupe is per session, never global");
  });

  await withSwitches({ SYMVANTA_AUGMENT_SEARCH: "off" }, async () => {
    const app = harness();
    await app.start();
    await app.emit("tool_call", { toolName: "grep", input: { pattern: "primer" }, toolCallId: "g1" });
    assert.deepEqual(app.asides(), [], "the search augmenter can be switched off alone");
  });
});

test("a glob call's path field is the search it performs", async () => {
  await withSwitches({}, async () => {
    const app = harness();
    await app.start();

    await app.emit("tool_call", { toolName: "glob", input: { path: "src/**/*.ts" }, toolCallId: "g1" });
    const search = app.guidance("search");
    assert.equal(search.length, 1, "the glob the model ran earns a note");
    assert.match(search[0].payload.content, /locate mode:file/);
    assert.match(search[0].payload.content, /src\/\*\*\/\*\.ts/, "the note quotes the glob it saw");

    await app.emit("tool_call", { toolName: "glob", input: {}, toolCallId: "g2" });
    assert.equal(app.guidance("search").length, 1, "a glob with no path names nothing to route");

    await app.emit("tool_call", { toolName: "glob", input: { pattern: "*.ts" }, toolCallId: "g3" });
    assert.equal(app.guidance("search").length, 1, "a stray pattern field is not the glob");

    // The same pattern in a different grep scope is a different search.
    await app.emit("tool_call", { toolName: "grep", input: { pattern: "primer", path: "src" }, toolCallId: "g4" });
    await app.emit("tool_call", { toolName: "grep", input: { pattern: "primer", path: "tests" }, toolCallId: "g5" });
    assert.equal(app.guidance("search").length, 3, "the scope is part of the search identity");
  });
});

test("the first read of a code file earns one aside, deduped by path", async () => {
  await withSwitches({}, async () => {
    const app = harness();
    await app.start();

    await app.emit("tool_call", { toolName: "read", input: { path: "src/app.ts" }, toolCallId: "r1" });
    const read = app.guidance("read");
    assert.equal(read.length, 1);
    assert.match(read[0].payload.content, /list_file_symbols/);

    await app.emit("tool_call", { toolName: "read", input: { path: "src/app.ts:1-20" }, toolCallId: "r2" });
    assert.equal(app.guidance("read").length, 1, "a selector on the same file is the same file");

    await app.emit("tool_call", { toolName: "read", input: { path: "src/other.ts" }, toolCallId: "r3" });
    assert.equal(app.guidance("read").length, 2);

    await app.emit("tool_call", { toolName: "read", input: { path: "README.md" }, toolCallId: "r4" });
    assert.equal(app.guidance("read").length, 2, "a non-code read earns nothing");
  });

  await withSwitches({ SYMVANTA_AUGMENT_READ: "off" }, async () => {
    const app = harness();
    await app.start();
    await app.emit("tool_call", { toolName: "read", input: { path: "src/app.ts" }, toolCallId: "r1" });
    assert.deepEqual(app.asides(), [], "the read augmenter can be switched off alone");
  });
});

test("read guidance treats every selector spelling as the same file", async () => {
  const selectors = [
    "50",
    "50-",
    "50-200",
    "50+150",
    "-60",
    "50..100",
    "50..",
    "5-16,960-973",
    "L50",
    "L5-L16",
    "raw",
    "img",
    "conflicts",
    "raw:2-4",
    "2-4:raw",
  ];

  // One fresh session per shape: the read notes have a per-session budget, so a
  // single session would stop earning notes before the list ends.
  for (const [index, selector] of selectors.entries()) {
    await withSwitches({}, async () => {
      const app = harness();
      await app.start();
      const file = `src/read-${index}.ts`;
      await app.emit("tool_call", { toolName: "read", input: { path: `${file}:${selector}` }, toolCallId: "r1" });
      const notes = app.guidance("read");
      assert.equal(notes.length, 1, `:${selector} must resolve to ${file}`);
      assert.ok(
        notes[0].payload.content.includes(file),
        `the note for :${selector} must name ${file}, got: ${notes[0].payload.content}`,
      );
    });
  }

  await withSwitches({}, async () => {
    const app = harness();
    await app.start();

    await app.emit("tool_call", { toolName: "read", input: { path: "src/same.ts:raw" }, toolCallId: "r1" });
    await app.emit("tool_call", { toolName: "read", input: { path: "src/same.ts:50-200" }, toolCallId: "r2" });
    assert.equal(app.guidance("read").length, 1, "a second spelling of the same file adds nothing");

    await app.emit("tool_call", { toolName: "read", input: { path: "src/plain.ts:member" }, toolCallId: "r3" });
    assert.equal(
      app.guidance("read").length,
      1,
      "an unrecognized colon tail stays in the path and is not a code file",
    );
  });
});

test("an empty successful grep earns one locate rescue, and nothing else does", async () => {
  await withSwitches({}, async () => {
    const app = harness();
    await app.start();

    await app.emit("tool_result", {
      toolCallId: "g1",
      toolName: "grep",
      input: { pattern: "ghostSymbol" },
      details: { matchCount: 0 },
      content: [{ type: "text", text: "No matches found" }],
      isError: false,
    });
    const rescue = app.guidance("rescue");
    assert.equal(rescue.length, 1);
    assert.match(rescue[0].payload.content, /locate/);
    assert.match(rescue[0].payload.content, /not a graph result/);

    await app.emit("tool_result", {
      toolCallId: "g2",
      toolName: "grep",
      input: { pattern: "ghostSymbol" },
      details: { matchCount: 0 },
      content: [{ type: "text", text: "No matches found" }],
    });
    assert.equal(app.guidance("rescue").length, 1, "the same failed query is rescued once");

    await app.emit("tool_result", {
      toolCallId: "g3",
      toolName: "grep",
      input: { pattern: "app" },
      details: { matchCount: 4 },
      content: [{ type: "text", text: "src/app.ts:1" }],
    });
    assert.equal(app.guidance("rescue").length, 1, "a search that matched is not rescued");

    await app.emit("tool_result", {
      toolCallId: "g4",
      toolName: "grep",
      input: { pattern: "broken" },
      details: { matchCount: 0 },
      isError: true,
      error: "bad pattern",
    });
    assert.equal(app.guidance("rescue").length, 1, "a failed search is an error, not an empty index");
  });

  await withSwitches({ SYMVANTA_AUGMENT_RESCUE: "off" }, async () => {
    const app = harness();
    await app.start();
    await app.emit("tool_result", {
      toolCallId: "g1",
      toolName: "grep",
      input: { pattern: "ghostSymbol" },
      details: { matchCount: 0 },
      content: [{ type: "text", text: "No matches found" }],
    });
    assert.deepEqual(app.asides(), [], "the rescue can be switched off alone");
  });
});

test("a No more results page is not treated as an empty search", async () => {
  await withSwitches({}, async () => {
    const app = harness();
    await app.start();

    await app.emit("tool_result", {
      toolCallId: "g1",
      toolName: "grep",
      input: { pattern: "app" },
      details: { matchCount: 0 },
      content: [{ type: "text", text: "No more results" }],
    });
    assert.deepEqual(app.guidance("rescue"), [], "paging past the end of a search that matched earns no rescue");

    await app.emit("tool_result", {
      toolCallId: "g2",
      toolName: "grep",
      input: { pattern: "ghostSymbol" },
      details: { matchCount: 0 },
      content: [{ type: "text", text: "No matches found" }],
    });
    assert.equal(app.guidance("rescue").length, 1, "a genuinely empty search still earns one");
  });
});

// ------------------------------------------------------------- attachment gating

test("the guard and the guidance stay silent until init observes an attached workspace", async () => {
  await withSwitches({ SYMVANTA_IMPACT_MODE: "strict" }, async () => {
    const app = harness();
    await app.start({ attached: null });

    const [allowed] = await app.emit("tool_call", { toolName: "edit", input: EDIT_APP, toolCallId: "e1" });
    assert.equal(allowed, undefined, "a workspace nothing has observed yet is not gated");
    const [prompt] = await app.emit("before_agent_start", { prompt: "how does `normalizeAlias` work?" });
    assert.equal(prompt, undefined, "an unobserved workspace earns no prompt note");
    await app.emit("tool_call", { toolName: "grep", input: { pattern: "primer" }, toolCallId: "g1" });
    await app.emit("tool_call", { toolName: "read", input: { path: "src/app.ts" }, toolCallId: "r1" });
    assert.deepEqual(app.asides(), [], "an unobserved workspace earns no search or read notes");

    await app.attach(true);
    const [blocked] = await app.emit("tool_call", { toolName: "edit", input: EDIT_APP, toolCallId: "e2" });
    assert.equal(blocked?.block, true, "the observed attachment arms the guard");
    const [promptAfter] = await app.emit("before_agent_start", { prompt: "how does `parseGitHubRemote` work?" });
    assert.ok(promptAfter?.message, "the observed attachment arms the prompt guidance");
  });
});

test("an unattached workspace keeps the guard and the guidance silent, and the widget says so", async () => {
  await withSwitches({ SYMVANTA_IMPACT_MODE: "strict" }, async () => {
    const app = harness();
    await app.emit("session_start", {});
    await app.attach(false);

    assert.equal(app.statusWrites().length, 1, "the widget still mirrors what the result said");
    assert.match(app.statusWrites()[0].text, /not attached/);

    const [allowed] = await app.emit("tool_call", { toolName: "edit", input: EDIT_APP, toolCallId: "e1" });
    assert.equal(allowed, undefined, "an unattached checkout is never gated");
    const [prompt] = await app.emit("before_agent_start", { prompt: "how does `normalizeAlias` work?" });
    assert.equal(prompt, undefined, "an unattached checkout earns no prompt note");
    await app.emit("tool_call", { toolName: "grep", input: { pattern: "primer" }, toolCallId: "g1" });
    await app.emit("tool_call", { toolName: "read", input: { path: "src/app.ts" }, toolCallId: "r1" });
    await app.emit("tool_result", {
      toolCallId: "g2",
      toolName: "grep",
      input: { pattern: "ghostSymbol" },
      details: { matchCount: 0 },
      content: [{ type: "text", text: "No matches found" }],
    });
    assert.deepEqual(app.asides(), [], "an unattached checkout earns no guidance at all");
  });
});

test("a new session drops the attachment observation until init reports again", async () => {
  await withSwitches({ SYMVANTA_IMPACT_MODE: "strict" }, async () => {
    const app = harness();
    await app.start();
    const [blocked] = await app.emit("tool_call", { toolName: "edit", input: EDIT_APP, toolCallId: "e1" });
    assert.equal(blocked?.block, true, "the attached session is gated");

    await app.emit("session_switch", { reason: "new" });
    const [silent] = await app.emit("tool_call", { toolName: "edit", input: EDIT_APP, toolCallId: "e2" });
    assert.equal(silent, undefined, "the new transcript has observed nothing yet");

    await app.attach(true);
    const [rearmed] = await app.emit("tool_call", { toolName: "edit", input: EDIT_APP, toolCallId: "e3" });
    assert.equal(rearmed?.block, true, "a fresh observation arms it again");
  });
});

test("the last attachment observation wins, and only a literal boolean moves it", async () => {
  await withSwitches({ SYMVANTA_IMPACT_MODE: "strict" }, async () => {
    const app = harness();
    await app.start();
    const [blocked] = await app.emit("tool_call", { toolName: "edit", input: EDIT_APP, toolCallId: "e1" });
    assert.equal(blocked?.block, true);

    await app.attach(false);
    const [silent] = await app.emit("tool_call", { toolName: "edit", input: EDIT_APP, toolCallId: "e2" });
    assert.equal(silent, undefined, "a later unattached observation disables the gated features again");

    await app.attach(true);
    const [rearmed] = await app.emit("tool_call", { toolName: "edit", input: EDIT_APP, toolCallId: "e3" });
    assert.equal(rearmed?.block, true, "and a later attached observation enables them again");

    // An init result that says nothing about attachment must not move it.
    await app.emit("tool_result", symvantaResult("init", { callId: "no-attachment", details: { workspace: { repository: "Symvanta/omp-plugin" } } }));
    const [stillArmed] = await app.emit("tool_call", { toolName: "edit", input: EDIT_APP, toolCallId: "e4" });
    assert.equal(stillArmed?.block, true, "a payload without workspace.attached leaves the observation untouched");

    // freshness and index_health are index observations, never attachment ones.
    await app.emit("tool_result", symvantaResult("freshness", { callId: "f1", details: { repository: { fullName: "Symvanta/omp-plugin" } } }));
    await app.emit("tool_result", symvantaResult("index_health", { callId: "h1", details: { degradedRepositories: [] } }));
    const [unchanged] = await app.emit("tool_call", { toolName: "edit", input: EDIT_APP, toolCallId: "e5" });
    assert.equal(unchanged?.block, true, "only an init result carries the attachment observation");
  });
});

test("a completed impact check opens the guard even while attachment is unknown", async () => {
  await withSwitches({ SYMVANTA_IMPACT_MODE: "strict" }, async () => {
    const app = harness();
    await app.start({ attached: null });

    await app.emit("tool_call", { toolName: "mcp__symvanta_relate", input: { kind: "blast_radius" }, toolCallId: "c1" });
    await app.emit("tool_result", { toolCallId: "c1", toolName: "mcp__symvanta_relate", input: { kind: "blast_radius" }, isError: false });

    const [allowed] = await app.emit("tool_call", { toolName: "edit", input: EDIT_APP, toolCallId: "e1" });
    assert.equal(allowed, undefined, "the check the model asked for is honoured on its own");
  });
});

// -------------------------------------------------------------------- privacy

test("a full session flow makes no network call", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    throw new Error("the plugin must never call fetch");
  };

  try {
    await withSwitches({}, async () => {
      const app = harness();
      await app.start();
      await app.emit("before_agent_start", { prompt: "how does `normalizeAlias` work?" });
      await app.emit("tool_call", { toolName: "grep", input: { pattern: "primer" }, toolCallId: "g1" });
      await app.emit("tool_call", { toolName: "read", input: { path: "src/app.ts" }, toolCallId: "r1" });
      await app.emit("tool_call", { toolName: "edit", input: EDIT_APP, toolCallId: "e1" });
      await app.emit("tool_result", symvantaResult("init", { callId: "s1", details: { workspace: { repository: "Symvanta/omp-plugin" } } }));
      await app.emit("tool_result", {
        toolCallId: "g1",
        toolName: "grep",
        input: { pattern: "primer" },
        details: { matchCount: 0 },
        content: [{ type: "text", text: "No matches found" }],
      });
      await app.commands.get("symvanta-status").handler("", app.ctx);
      await app.emit("session_switch", { reason: "new" });
      await app.emit("session_shutdown", {});
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.equal(calls, 0, "the extension must not use the network");
});
