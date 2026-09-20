# Symvanta plugin for oh-my-pi (OMP)

One-step setup for working in a [Symvanta](https://symvanta.com)-indexed codebase
under oh-my-pi. Installing this plugin:

- registers the Symvanta code-graph MCP server for you (Cloud endpoint by
  default, overridable for staging or on-prem), so you never hand-edit an MCP
  config;
- injects repository binding context at session start, so the agent calls `init`
  with this checkout's `owner/name` instead of guessing which project to read;
- gates edits of existing code on a real impact check, with selectable modes, so
  a change lands only after `relate` (kind:blast_radius) or `estimate_scope` has
  completed successfully for it;
- ships two task agents (`symvanta-explorer`, `symvanta-tracer`), an always-apply
  navigation rule, twelve `/symvanta-*` commands, and the `symvanta` skill, so
  graph-first navigation is the default path rather than an option you have to
  remember;
- adds guidance-only augmentation: hidden prompt guidance plus local-search
  nudges and an empty-`grep` rescue that point the agent at the graph without
  ever querying it on its own;
- shows an observation-only status line and below-editor widget built from
  `init`, `freshness`, and `index_health` results the agent already fetched.

## Requirements

- oh-my-pi with plugin support (`omp plugin --help` lists the actions this
  README uses).
- A Symvanta account whose workspace has at least one repository indexed. An
  account with no indexed repository still installs cleanly: the plugin degrades
  to plain local work and says so instead of inventing results.

## Install

There are two lanes. They differ in what they install, where it lives, and the
names OMP registers, so pick one and use its names throughout.

| | Direct Git install | Marketplace install |
| --- | --- | --- |
| Scope | user-wide (every checkout) | project (`--scope project`) |
| MCP server name | `symvanta` | `symvanta:symvanta` |
| Command names | `/symvanta-ask` and the other eleven | `/symvanta-ask` and the other eleven through the extension aliases, plus the namespaced file commands `symvanta:symvanta-*` |
| Uninstall | `omp plugin uninstall @symvanta/omp-plugin` | `omp plugin uninstall --scope project symvanta@symvanta-omp` |

### From GitHub (direct, user-wide)

```
omp plugin install github:Symvanta/omp-plugin
```

Installing straight from the repository is what makes the names in this README
the names you get: the MCP server registers as `symvanta` and the commands
register as `/symvanta-*`, unchanged.

A Git install is user-wide. The plugin lands in the user-wide plugin root and
loads from every checkout, and the installer's `--scope` flag is honored only for
marketplace installs (`name@marketplace`), so adding a project scope to a Git
install changes nothing. Where project-level control is wanted, use the
marketplace lane below, or scope the MCP server definition itself with
`/mcp add symvanta --url <endpoint> --scope project`.

`omp plugin list` shows the registered plugins, and `omp plugin doctor` reports
drift in plugin state (`omp plugin doctor --fix` repairs what it can).

### From the marketplace (project-scoped)

The repository ships a catalog at `.omp-plugin/marketplace.json` (marketplace
name `symvanta-omp`, plugin name `symvanta`), so it can be added as a marketplace
and installed into one project:

```
omp plugin marketplace add Symvanta/omp-plugin
omp plugin install --scope project symvanta@symvanta-omp
```

A project-scoped install lives in `<project>/.omp/plugins/` and is available only
in that project; a user-scoped marketplace install (`--scope user`, or omitting
the flag) is also possible and is available in every project. Project-scoped
installs shadow user-scoped installs of the same plugin ID. The in-session
equivalents are `/marketplace add Symvanta/omp-plugin` and
`/marketplace install --scope project symvanta@symvanta-omp`.

Marketplace installs route the plugin through OMP's name rewriting, so read
[Marketplace namespacing](#marketplace-namespacing) before you type a server or
command name.

### From a local checkout (development)

```
omp plugin link /path/to/omp-plugin
```

`omp plugin link` symlinks the checkout into the user plugin root instead of
copying it, so edits in the working tree are what the next reload loads. There is
no cached copy to update and no reinstall step.

## Marketplace namespacing

A marketplace install is namespaced: OMP prefixes every command and MCP server
name the plugin contributes with the plugin name, while a direct Git install
keeps the plain names. Concretely, for plugin name `symvanta` published by
marketplace `symvanta-omp`:

- the MCP server in `.mcp.json` (`symvanta`) registers as `symvanta:symvanta`, so
  every `/mcp` subcommand takes that name: `/mcp test symvanta:symvanta`,
  `/mcp reauth symvanta:symvanta`, `/mcp unauth symvanta:symvanta`;
- the markdown commands in `commands/` register as `symvanta:symvanta-ask`,
  `symvanta:symvanta-blast`, and so on;
- the extension module registers command aliases for all twelve stable
  `/symvanta-*` names, so `/symvanta-ask`, `/symvanta-blast`, and the rest keep
  working in both lanes. Extension commands are dispatched before file commands,
  so the aliases win and the namespaced copies remain available.

A direct Git install has no rewriting: the server is `symvanta` and the commands
are `/symvanta-*`, with no aliases needed. When in doubt, `/mcp list` shows the
server name that actually registered, and `/reload-plugins` lists the commands.

## Reload and restart

Plugin state is read at defined points, not continuously:

| Change | What picks it up |
| --- | --- |
| Skills, slash commands, MCP servers | `/reload-plugins` |
| The extension module (session-start context, session-switch primer, impact gate, augmenters, status widget) | restart the session |
| MCP server definitions only | `/mcp reload`, or `/mcp reconnect <server>` |

`omp plugin install`, `omp plugin link`, and `omp plugin uninstall` mutate disk
state and invalidate discovery caches; they do not rebuild the session you are
sitting in. Run `/reload-plugins` after an install or upgrade, and restart the
session the first time so the extension module loads. There is no file watcher
behind slash commands or skills.

## Sign in (OAuth)

Every Symvanta MCP server (Cloud, staging, or on-prem) advertises its own OAuth
endpoints, so OMP runs the browser sign-in on first connection and there is
nothing to configure in the plugin. The credential is stored and refreshed by
OMP's auth storage or broker, keyed to the server URL; the plugin never reads it
and never talks to the endpoint itself.

```
/mcp list                        # confirm the registered server name for your lane
/mcp test symvanta               # direct Git install
/mcp test symvanta:symvanta      # marketplace install
/mcp reconnect symvanta          # reconnect this server without rediscovering every config
/mcp reauth symvanta             # replace the stored OAuth credential
/mcp unauth symvanta             # remove the stored credential
```

Run `/mcp reauth <server>` after a credential expires, after signing in as a
different account, or after changing `SYMVANTA_MCP_URL` (a new URL is a new
credential binding). Under a marketplace install, `<server>` is
`symvanta:symvanta`.

## Configuration

### Point at another Symvanta server

The plugin ships the server URL as
`${SYMVANTA_MCP_URL:-https://mcp.symvanta.com/mcp}`, which OMP expands while
discovering MCP configs. Leave the variable unset and you get Symvanta Cloud. To
use staging or an on-prem server, export the full endpoint URL before launching
oh-my-pi:

```
export SYMVANTA_MCP_URL=https://mcp.your-company.com/mcp
omp
```

Use the complete URL including the `/mcp` path, with no trailing slash: a bare
host or a trailing slash fails to connect. Existing sessions keep the URL they
discovered, so run `/mcp reload` (and re-authorize if the URL changed) after
editing the variable.

### Impact modes

`SYMVANTA_IMPACT_MODE` selects how the pre-edit gate behaves. Values are trimmed
and case-insensitive; a missing, empty, or unknown value selects `once`.

| Mode | Behavior |
| --- | --- |
| `once` (default) | Refuses the first edit or write of existing code until a `relate` (kind:blast_radius) or `estimate_scope` call has completed successfully in this session. Once a check succeeds, later edits are ungated. |
| `strict` | Refuses every edit or write of existing code until an impact check completes successfully, and never stops refusing after a fixed number of refusals: if the server never answers, the mutation stays refused instead of failing open. |
| `warn` | Never blocks. An unchecked edit or write of existing code runs, and a hidden note beside it names the check that would have covered it, once per file. |
| `off` | No gating and no note. |

```
export SYMVANTA_IMPACT_MODE=warn
```

The gate is observed-attachment aware, because a user-wide install loads in
checkouts Symvanta has never seen. It stays silent until a successful `init`
result reports `workspace.attached: true` for this session, and an `init` result
that reports `workspace.attached: false` keeps it silent: no refusal and no
advisory either way. The one exception is a check that already completed
successfully: the agent asked for it explicitly, so it opens the gate whatever
the last observation said. Only an `init` result carries this observation
(`freshness` and `index_health` results never change it), and each new session
starts unobserved.

The gate is per session, not per turn. New files and non-code files always pass.
When the Symvanta impact tools are not loaded, every mode fails open. Once those
tools are present, `strict` continues refusing after a failed or unavailable
impact result until one completes successfully.

### Guidance augmenters

The extension can add hidden, guidance-only context: a prompt primer that tells
the agent to prefer the graph, a one-time nudge after local `grep`, `glob`, or
`bash` searches on an attached repository, a one-time nudge after `read`, and a
rescue when a `grep` comes back empty (call `locate` with no mode so it
auto-routes to semantic search). The read nudge is keyed to the file, so any
selector the read tool accepts
(`:50`, `:50-200`, `:50+150`, `:-60`, `:5-16,960-973`, `:50..100`, `:raw`,
`:img`, `:conflicts`, and mode words mixed with ranges like `:raw:2-4`) is the
same file and earns one note. The rescue fires only for a search that found
nothing: a `No more results` page, which is paging past the end of a search that
did match, is not an empty search. The tool nudges are deduped per session per
subject, while the prompt note is deterministic: the same submission, including
a retry OMP runs after a source-base change, gets the same note. None of them
query the graph, read credentials, or make network requests: they are text the
agent may act on with its own tool calls.

Every augmenter has a switch. Values are trimmed and case-insensitive, and `off`,
`false`, `0`, or `no` disables the feature.

| Variable | Turns off |
| --- | --- |
| `SYMVANTA_AUGMENT` | every augmenter below |
| `SYMVANTA_AUGMENT_PROMPT` | the prompt routing note |
| `SYMVANTA_AUGMENT_SEARCH` | the `grep`/`glob`/`bash` search note |
| `SYMVANTA_AUGMENT_READ` | the first-read note |
| `SYMVANTA_AUGMENT_RESCUE` | the empty-`grep` rescue |
| `SYMVANTA_AUGMENT_DEDUPE` | the tool-guidance dedupe, so those notes may repeat (the prompt note is deterministic by design and unaffected) |

```
export SYMVANTA_AUGMENT_SEARCH=off
```

`SYMVANTA_AUGMENT=off` disables every augmenter (the impact gate and the status
widget are unaffected).

Every augmenter is also observed-attachment aware: none of them add anything
until a successful `init` result reports `workspace.attached: true`, and an
unattached result keeps them silent, so a user-wide install never advises routing
through a graph that does not have this checkout.

### Timeout

The server entry sets a 120000 ms request timeout, because architecture and
blast-radius queries over a large graph take longer than a chat round trip.
`OMP_MCP_TIMEOUT_MS` takes process-wide precedence over every per-server timeout
if you need to raise it further, or set it to `0` to disable client-side MCP
timeouts.

## Commands

Each command routes to the right graph tool so you do not have to remember tool
names. All twelve are registered by the extension as stable `/symvanta-*` aliases
in both install lanes. Arguments are inserted literally: the template's
`$ARGUMENTS` (or `$@`) placeholder is replaced, and anything in your own text
that looks like a replacement pattern (`$&`, `` $` ``, `$'`, `$$`, `$1`,
`$<name>`, `$@`) stays exactly as you typed it, because the substitution is a
single pass that never rescans what it inserted.

| Command | What it does |
| --- | --- |
| `/symvanta-ask [question]` | Answer a behavior question ("how does X work", "why does Y happen", "what triggers Z") from the graph, with file citations. |
| `/symvanta-blast [symbol or path:symbol]` | Blast-radius check before editing a symbol: what breaks across files, layers, and repositories. Satisfies the pre-edit gate. |
| `/symvanta-trace [symbol]` | Trace a symbol: full call chain, direct callers, and dependencies, instead of reading files one by one. |
| `/symvanta-status [repository (optional)]` | Connection and index health snapshot: bound project, indexed repositories, freshness, graph density, and MCP wiring. The pre-edit gate runs in-process inside the extension, so this snapshot cannot report it. |
| `/symvanta-architecture [repository (optional)]` | High-level architecture of the indexed codebase: functional modules, their hubs, cross-module coupling, and the load-bearing functions. |
| `/symvanta-scope [symbol or change description]` | Pre-flight scope estimate for a change before sizing or planning it, grounded in the graph instead of a guess at call sites. |
| `/symvanta-tests [symbol]` | Find the existing tests that cover a symbol, from the graph rather than by guessing at test file names. |
| `/symvanta-working-tree [repository (optional)]` | Overlay uncommitted working-tree edits onto a synthetic indexed revision so graph, text, and symbol tools reflect unpushed changes. |
| `/symvanta-route [route path] [method (optional)]` | Resolve an HTTP route to the handler and middleware that serve it, from framework router metadata instead of a grep for the URL string. |
| `/symvanta-branch [branch name, or clear (optional)]` | Pin this session's graph reads to a tracked branch, or drop the pin, so results describe that branch instead of the default branch. |
| `/symvanta-recent [path (optional)]` | Recent indexed history: the files changing most often, and the latest commits, optionally scoped to one path. |
| `/symvanta-clear [branch \| working-tree \| project (optional)]` | Drop the Symvanta session pin: the branch or working-tree revision pin by default, and the project binding only when explicitly asked. |

## Agents

The plugin ships two OMP task agents. Dispatch them with the `task` tool by name,
or let the policy in the rule pick them for graph-shaped work:

- `symvanta-explorer` explores an attached repository through the graph before
  any local search: bind, orient, then read only what the graph points at.
- `symvanta-tracer` follows a symbol: callers, dependencies, blast radius, and
  the call chain that reaches it.

Both are read-only investigators: they answer with graph-grounded citations and
never edit files.

## Status widget

The extension registers an observation-only status line and a below-editor
widget. They render only what successful `init`, `freshness`, and `index_health`
tool results already reported in this session (bound repository, index freshness,
indexed repository count), and they say nothing when no such result has arrived
yet. An `init` result that reports `workspace.attached: false` is mirrored as
`not attached`, which is the same result that keeps the gated features silent.
The widget never queries the graph, never reads credentials, and never changes
what the agent does; it is a mirror of results the agent fetched, not a second
client.

## What runs at runtime

The plugin is one extension module (`src/index.ts`) plus a pure helper
(`src/repository.js`), a rule, twelve commands, two agents, and a skill. It
registers these event handlers:

- **`session_start`** reads the checkout's git remote (`git config --get
  remote.origin.url`, via `execFile` with no shell and a timeout), derives
  `owner/name`, and injects context that tells the agent to call `init` with that
  `repository`. That binding is what makes "the default project" this checkout
  rather than some other codebase in the workspace. With no remote, or when the
  checkout is not indexed, the injected text says so and the agent is told to
  work without the graph. Nothing is sent anywhere at session start.
- **`session_switch`** re-runs the session-start routine when the switch reason
  is `new`, which is what `/new` emits when the runtime swaps in an empty
  transcript inside the same process: the primer is queued again, the previous
  session's status line and widget are cleared (even though the new transcript
  has a new session id), and the guard starts over, so a fresh conversation
  neither loses the binding nor inherits the previous transcript's satisfied
  gate. Other reasons (`switch`, `fork`, `resume`) carry the transcript they
  loaded, so nothing is reissued for them.
- **`before_agent_start`** reads the prompt being prepared and, when it names
  symbol-shaped terms, returns one hidden, agent-attributed companion message
  naming the graph calls that would resolve them. It is deterministic per
  submission: the same prompt, including a retry OMP runs after a source-base
  change, gets the same note, and the note is claimed by no counter, because a
  note claimed by a discarded attempt would be lost. It is silent until an
  `init` result has observed `workspace.attached: true`.
- **`tool_call`** watches the agent's own tool calls. It refuses edits according
  to `SYMVANTA_IMPACT_MODE`: in `once` it blocks the first `edit`/`write` that
  would modify existing code when no impact check has completed yet, then
  latches open once one succeeds; in `strict` it keeps refusing until a check
  completes and never fails open; `warn` adds a hidden note instead of blocking;
  `off` does nothing. The same handler recognizes local searches and code reads
  and adds the guidance-only asides, which never block or rewrite a call. Both
  stay silent until an `init` result has observed `workspace.attached: true`
  (see [Impact modes](#impact-modes)), because a user-wide install may be
  running in a checkout Symvanta has never indexed. New files and non-code files
  pass untouched. If the Symvanta impact tools are not loaded, the guard fails
  open; once they are present, `strict` keeps refusing until a check succeeds.
  Edit targets are read from every wire shape
  the host can send: the `path`/`file_path`/`filePath` fields and their plural
  siblings, a path array, and patch payloads in each dialect the host emits, the
  hashline `[path#hash]` sections, the `*** Update File:`, `*** Delete File:` and
  `*** Add File:` markers, and the sloppy-mode `*** SM:EDIT path` and
  `<SM:EDIT path="...">` spellings (the attribute may also be spelled `file=`). A
  quoted path, a copied `[path]` or `[path#hash]` wrapper, a `~/` home prefix, and
  the OMP path aliases `file:///absolute`, `@/absolute`, `@~/` and `:/absolute`
  are all normalized before the target is checked; a target that names a non-file
  scheme (`https://`, `xd://`) is skipped instead of being resolved against the
  checkout.
- **`tool_result`** decides whether that check counted. It tracks impact calls by
  tool call id while they are in flight and opens the gate only for one that
  completed successfully, so a check issued in the same batch as an edit cannot
  wave that edit through, and a failed check leaves the gate shut. The same
  result stream feeds the augmenters (search/read nudges, empty-grep rescue) and
  the status widget, all read-only, and records the attachment observation: only
  a successful `init` result carrying a literal boolean `workspace.attached`
  moves it, and that observation is what lets the gate and the augmenters speak.
  It never patches a result.
- **`session_shutdown`** drops this session's gate state, including any call that
  was still pending, so nothing leaks into the next session in the process.

Symvanta tool names are recognized defensively: the extension resolves the bare
tool name from the origin the host reports (the MCP server and tool name on a
definition) and, failing that, from the wire name with the `mcp__` prefix and any
repeated server token stripped, accepting the tail only when it names a known
Symvanta tool. `mcp__symvanta_relate`, `mcp__symvanta__relate`, and the
marketplace-shaped `mcp__symvanta_symvanta_relate` therefore all resolve to
`relate`, which is what keeps the gate armed no matter which install shape the
session runs under.

The always-apply rule (`rule://symvanta`) carries the standing policy: bind with
`init`, open unfamiliar work with `context`, prefer the graph over ad-hoc shell
search on an attached indexed repository (`grep`, `glob`, and shell `grep`/`rg`
are a fallback, not a first move, and an empty local `grep` is rescued by calling
`locate` with no mode so it auto-routes to semantic search), check blast radius
before editing, read the local file after the graph gives you the location, use
`lsp` for exact references and refactors, check `freshness` before trusting
results after a recent push, and fall back to local search only when the checkout
is not attached. The `symvanta` skill holds the full tool decision matrix.

### Direct MCP and the XD write-device bridge

Symvanta tools can reach a session two ways, and the extension reads both
through one unwrapping seam:

- **Direct MCP tools**, whose wire names the host mints (`mcp__symvanta_relate`,
  or the marketplace-shaped `mcp__symvanta_symvanta_relate`). The bare tool name
  is resolved from the origin the host reports on the definition and, failing
  that, from the wire name itself.
- **XD write devices**, when the harness exposes the same tools as `write`
  targets instead of mounted MCP tools: a `write` whose `path` is
  `xd://mcp__symvanta_<tool>` carries the tool's JSON arguments as the write
  content, and the seam turns that into the same logical invocation — the
  `xd://` path names the tool, the content carries the arguments.

Ownership is proven at the server segment, never by the tail: the device must be
the MCP wire name the host mints for the Symvanta server itself
(`xd://mcp__symvanta_<tool>`, its `xd://mcp__symvanta__<tool>` separator
spelling, or the marketplace-doubled
`xd://mcp__symvanta_symvanta_<tool>`), with a tail the Symvanta tool table
knows. A device owned by another server is foreign even when its tail says
otherwise — `xd://mcp__github_symvanta_relate` is not Symvanta's, because the
server that owns it is not — and a device name that merely ends in the same
letters or prefixes them (`xd://symvanta_relate`, `xd://mcp__notsymvanta_relate`)
is not Symvanta's either. Every foreign device is left alone: `xd://lsp`,
`xd://mcp__github_*`, or a `xd://mcp__symvanta_*` tail that is not a Symvanta
tool stays an ordinary write.

A device call can also be a schema lookup rather than a call: content that is
empty, missing, `?`, or `help` asks the device to describe itself, and the device
may say so on the result instead, as `details.xdev.mode: "help"`. A help-mode
result is inert no matter how successful the outer `write` was — it never feeds
the status bar, never records an attachment observation, never arms the guard,
and never counts as an impact check. Malformed JSON content is inert the same
way: it names no executable arguments, so it cannot satisfy a check. Only a
`write` whose content is the tool's JSON arguments (or an already-parsed
argument object) is a real call.

This is why the status bar and the impact gate work in a harness that exposes
the graph through write devices: a bridged `init` result feeds the widget and
carries the same `workspace.attached` observation a direct one does, so it arms
the gate and the augmenters; a bridged `freshness` or `index_health` result
feeds the widget; and a bridged `relate` (kind: blast_radius) or
`estimate_scope` counts as the impact check that opens the gate, tracked by the
outer `write` call's tool-call id so a check that is still in flight or one that
failed never waves an edit through. A successful bridged `init` is also what
proves the tools are reachable when the harness mounts no MCP tool definitions,
so the refusal names `relate` and `estimate_scope` instead of failing open.
Nothing here adds a network call: the write device is OMP's own path to the MCP
server, and the plugin still only reads the results the host hands it.

### Why the Claude Code hook family is not copied

The Claude Code plugin ships per-tool "augmenter" hooks that read the stored
Symvanta token from Claude Code's credential store and speak HTTP to the MCP
endpoint themselves, with local caches and a local activity log. That shape
exists because Claude Code hooks are separate processes that cannot call MCP
tools through the host.

OMP does not need it, and this plugin deliberately does not reproduce it:

- the extension runs in-process on OMP's event bus, so it can observe tool calls
  (the pre-edit gate) and add hidden guidance (the augmenters) without spawning a
  process per tool call;
- MCP auth stays broker-managed by OMP: the extension never reads a credential
  file, never holds a token, and never makes a direct HTTP request;
- the standing policy lives in an always-apply rule, which is injected into the
  system prompt, so there is no per-tool hook script to audit or to fail.

## Privacy

- No telemetry, no analytics, no background processes, and no daemon.
- The extension makes no network requests at all. It reads the checkout's git
  remote and file extensions locally, and talks to OMP through the event bus.
  The augmenters only add text to prompts and tool results; they never call the
  graph themselves, so nothing in this plugin fabricates a graph answer.
- Nothing gated speaks about a checkout Symvanta has not confirmed: until a
  successful `init` result reports `workspace.attached: true`, the impact gate
  and every augmenter add nothing, and an unattached result keeps them quiet for
  the rest of the session unless a later `init` result says otherwise.
- Every graph query is an MCP tool call the agent decides to make, over the same
  HTTPS connection and OAuth credential you authorized, through OMP's MCP client.
  What leaves the machine is exactly those tool arguments (identifiers, task
  descriptions, repo-relative paths, the repository slug), never file contents
  unless a tool call explicitly asks for them.
- The plugin writes no caches, logs, or state files of its own. Credentials live
  in OMP's auth storage; uninstall does not touch them (see below).
- The repository is private for now, and small enough to read end to end:
  `src/index.ts` and its runtime modules are the entire runtime.

## Uninstall

Each install lane uninstalls under its own identity:

```
omp plugin uninstall @symvanta/omp-plugin                      # direct Git install
omp plugin uninstall --scope project symvanta@symvanta-omp     # marketplace install
```

`omp plugin list` shows the registered name if you are unsure of the spelling.
Uninstall removes the registration and any copy OMP made at install time; a
linked checkout is only unlinked, so its working tree stays on disk. Neither case
removes the OAuth credential: drop it with `/mcp unauth symvanta` (or
`/mcp unauth symvanta:symvanta` for the marketplace lane) if you also want to
sign out.

## Layout

```
.omp-plugin/marketplace.json   marketplace catalog (symvanta-omp / symvanta, source ./)
.mcp.json                      Symvanta MCP server definition (http, env-overridable URL)
package.json                   omp.extensions manifest
src/index.ts                   session context, impact gate, augmenters, status widget, command aliases
src/repository.js              git-remote parsing and startup-context text (pure)
rules/symvanta.md              always-apply navigation policy (rule://symvanta)
commands/symvanta-*.md         the twelve slash commands
agents/symvanta-*.md           the explorer and tracer task agents
skills/symvanta/SKILL.md       tool decision matrix and conventions
scripts/validate.mjs           dependency-free contract validator
test/validate.test.mjs         validator contract tests and the extension's static contract
test/extension.test.mjs        behavioral tests driving the extension with a fake ExtensionAPI
test/repository.test.mjs       startup-context and git-remote parsing tests
```

Run the contract validator with `node scripts/validate.mjs`; run the tests with
`node --test`. Both use Node built-ins only and need no install step.

## License

MIT
