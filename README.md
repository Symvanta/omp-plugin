# Symvanta plugin for oh-my-pi (OMP)

Work in a [Symvanta](https://symvanta.com)-indexed codebase from oh-my-pi. The
plugin registers the Symvanta code-graph MCP server, binds each session to the
checkout you opened, and routes navigation and impact questions through the
graph.

Installing it gives you:

- the Symvanta MCP server definition, pointed at Symvanta Cloud by default and
  overridable for staging or on-prem;
- repository binding context at session start, so the agent calls `init` with
  this checkout's `owner/name`;
- a pre-edit impact gate that refuses a change to existing code until a `relate`
  (kind: `blast_radius`) or `estimate_scope` call completes;
- two task agents (`symvanta-explorer`, `symvanta-tracer`), an always-apply
  navigation rule, twelve `/symvanta-*` commands, and the `symvanta` skill;
- guidance-only augmenters: hidden prompt guidance, local-search nudges, and a
  rescue for an empty local search;
- an observation-only status line and a below-editor widget.

## Requirements

- oh-my-pi with plugin support. Run `omp plugin --help` to check that the
  actions below exist.
- A Symvanta account with at least one indexed repository. An account without
  one still installs cleanly: the impact gate and the augmenters stay silent,
  the widget shows the checkout as `not attached`, and the agent works from
  local files.

## Install

Two lanes exist. Choose one below and use its names for the rest of this page.

| | Direct Git install | Marketplace install |
| --- | --- | --- |
| Scope | user-wide, every checkout | project, with `--scope project` |
| MCP server name | `symvanta` | `symvanta:symvanta` |
| Command names | `/symvanta-ask` and the other eleven | the same twelve names through the extension aliases, plus the namespaced file commands `symvanta:symvanta-*` |
| Uninstall | `omp plugin uninstall @symvanta/omp-plugin` | `omp plugin uninstall --scope project symvanta@symvanta-omp` |

### From GitHub (direct, user-wide)

```
omp plugin install github:Symvanta/omp-plugin
```

The MCP server registers as `symvanta` and the commands register as
`/symvanta-*`. Those are the names this page documents.

This install is user-wide: the plugin lands in the user plugin root and loads in
every checkout. The installer honors `--scope` only for marketplace installs
(`name@marketplace`), so adding a scope to a Git install changes nothing. For
project-level control, use the marketplace lane below, or scope the MCP server
definition on its own:

```
/mcp add symvanta --url <endpoint> --scope project
```

`omp plugin list` shows the registered plugins. `omp plugin doctor` reports
drift in plugin state, and `omp plugin doctor --fix` repairs what it can.

### From the marketplace (project-scoped)

The repository ships a catalog at `.omp-plugin/marketplace.json` under the
marketplace name `symvanta-omp` and the plugin name `symvanta`:

```
omp plugin marketplace add Symvanta/omp-plugin
omp plugin install --scope project symvanta@symvanta-omp
```

A project-scoped install lives in `<project>/.omp/plugins/` and loads in that
project only. `--scope user`, or omitting the flag, installs for every project.
A project-scoped install shadows a user-scoped install of the same plugin ID.
The in-session equivalents are `/marketplace add Symvanta/omp-plugin` and
`/marketplace install --scope project symvanta@symvanta-omp`.

A marketplace install routes the plugin through OMP's name rewriting. Read
[Marketplace namespacing](#marketplace-namespacing) before you type a server or
command name.

### From a local checkout (development)

```
omp plugin link /path/to/omp-plugin
```

`omp plugin link` symlinks the checkout into the user plugin root, so the next
reload loads your working tree. No reinstall step is needed.

## Marketplace namespacing

A marketplace install is namespaced: OMP prefixes every command and MCP server
name the plugin contributes with the plugin name. A direct Git install keeps the
plain names. For plugin name `symvanta` published by marketplace `symvanta-omp`:

- the server in `.mcp.json` (`symvanta`) registers as `symvanta:symvanta`, so
  every `/mcp` subcommand takes that name: `/mcp test symvanta:symvanta`,
  `/mcp reauth symvanta:symvanta`, `/mcp unauth symvanta:symvanta`;
- the markdown commands in `commands/` register as `symvanta:symvanta-ask`,
  `symvanta:symvanta-blast`, and so on;
- the extension registers command aliases for all twelve stable `/symvanta-*`
  names, so `/symvanta-ask`, `/symvanta-blast`, and the rest keep working in
  both lanes. Extension commands take precedence, and the namespaced file
  commands stay available.

A direct Git install needs no aliases: the server is `symvanta` and the commands
are `/symvanta-*`. Use `/mcp list` for server names and `/reload-plugins` for
command names.

## Reload and restart

Reload plugin state as follows:

| Change | What picks it up |
| --- | --- |
| Skills, slash commands, MCP servers | `/reload-plugins` |
| The extension module (session context, impact gate, augmenters, status widget) | restart the session |
| MCP server definitions only | `/mcp reload`, or `/mcp reconnect <server>` |

`omp plugin install`, `omp plugin link`, and `omp plugin uninstall` change disk
state and invalidate discovery caches. They do not rebuild the session you are
sitting in. After an install or upgrade, run `/reload-plugins`. After the first
install, restart the session so the extension module loads. No file watcher sits
behind slash commands or skills.

## Sign in (OAuth)

Every Symvanta MCP server (Cloud, staging, or on-prem) advertises its own OAuth
endpoints, so OMP opens the browser sign-in on first connection. The plugin
needs no OAuth configuration. OMP stores and refreshes the credential, keyed to
the server URL.

```
/mcp list                        # confirm the registered server name for your lane
/mcp test symvanta               # direct Git install
/mcp test symvanta:symvanta      # marketplace install
/mcp reconnect symvanta          # reconnect this server without rediscovering every config
/mcp reauth symvanta             # replace the stored OAuth credential
/mcp unauth symvanta             # remove the stored credential
```

After a credential expiry, an account switch, or a `SYMVANTA_MCP_URL` change, run
`/mcp reauth <server>`: each URL binds its own credential. Under a marketplace
install, `<server>` is `symvanta:symvanta`.

## Configuration

### Point at another Symvanta server

The plugin ships the server URL as
`${SYMVANTA_MCP_URL:-https://mcp.symvanta.com/mcp}`, which OMP expands while
discovering MCP configs. With the variable unset you get Symvanta Cloud. Export
the full endpoint URL before launching oh-my-pi to use staging or an on-prem
server:

```
export SYMVANTA_MCP_URL=https://mcp.your-company.com/mcp
omp
```

Use the complete URL including the `/mcp` path and no trailing slash. A bare
host or a trailing slash fails to connect. Run `/mcp reload` to refresh a running
session's endpoint URL, and re-authorize after a URL change.

### Impact modes

`SYMVANTA_IMPACT_MODE` selects how the pre-edit gate behaves. Values are trimmed
and case-insensitive, and a missing, empty, or unknown value selects `once`.

| Mode | Behavior |
| --- | --- |
| `once` (default) | Refuses the first unchecked `edit` or `write` of existing code, then fails open. A successful `relate` (kind: `blast_radius`) or `estimate_scope` call in this session satisfies the gate and lifts the refusal for the rest of the session. |
| `strict` | Refuses every `edit` or `write` of existing code until an impact check completes successfully. Repeated refusals never disable the gate, so the mutation stays refused when the server never answers. |
| `warn` | Never blocks. An unchecked `edit` or `write` of existing code runs, and one hidden note per file names the check that would have covered it. Notes stop once an impact check completes successfully. |
| `off` | No gating and no note. |

```
export SYMVANTA_IMPACT_MODE=warn
```

The gate waits for evidence that this checkout is attached. A successful `init`
result that reports `workspace.attached: true` activates it. A result reporting
`workspace.attached: false` keeps it silent, with no refusal and no advisory.
Only `init` updates that state: `freshness` and `index_health` leave it
unchanged, and each session starts unobserved. A successful explicit impact
check opens the gate whatever the state says, because the agent asked for it.

Gate state is per session. New files and non-code files always pass. When the
Symvanta impact tools are not loaded, every mode fails open.

### Guidance augmenters

The extension can add hidden, guidance-only context:

- a prompt primer that tells the agent to prefer the graph;
- a one-time nudge after a local `grep`, `glob`, or `bash` search on an attached
  repository;
- a one-time nudge after `read`;
- a rescue when a `grep` comes back empty: call `locate` with no mode so it
  auto-routes to semantic search.

The read nudge runs once per file: every selector the read tool accepts (`:50`,
`:50-200`, `:50+150`, `:-60`, `:5-16,960-973`, `:50..100`, `:raw`, `:img`,
`:conflicts`, and mode words mixed with ranges such as `:raw:2-4`) shares that
file's dedupe key. The rescue runs only when a search found nothing. A
`No more results` page means an earlier page did match, so it is not an empty
search. Tool nudges are deduped per session per subject. The prompt note is
deterministic: the same submission gets the same note, including a retry OMP
runs after a source-base change. Augmenters add text; the agent decides whether
to call a tool.

Every augmenter has a switch. Values are trimmed and case-insensitive, and
`off`, `false`, `0`, or `no` disables the feature.

| Variable | Turns off |
| --- | --- |
| `SYMVANTA_AUGMENT` | every augmenter below |
| `SYMVANTA_AUGMENT_PROMPT` | the prompt routing note |
| `SYMVANTA_AUGMENT_SEARCH` | the `grep`/`glob`/`bash` search note |
| `SYMVANTA_AUGMENT_READ` | the first-read note |
| `SYMVANTA_AUGMENT_RESCUE` | the empty-`grep` rescue |
| `SYMVANTA_AUGMENT_DEDUPE` | the tool-guidance dedupe, including `warn` notes, so those notes may repeat. Prompt notes are unaffected. |

```
export SYMVANTA_AUGMENT_SEARCH=off
```

The impact gate and the status widget ignore these switches. The dedupe switch
is the exception: it also governs whether repeated `warn` notes are suppressed,
and `SYMVANTA_AUGMENT=off` disables dedupe along with the other augmenters.

Augmenters follow the same attachment rule as the impact gate.

### Timeout

The server entry sets a 120000 ms request timeout, because architecture and
blast-radius queries over a large graph take longer than a chat round trip.
`OMP_MCP_TIMEOUT_MS` overrides every per-server timeout. Set it to `0` to disable
client-side MCP timeouts.

## Commands

Each command routes to the right graph tool, so you do not have to remember tool
names. The extension registers all twelve in both install lanes.

Arguments are inserted literally: the extension replaces the template's
`$ARGUMENTS` (or `$@`) placeholder in a single pass and preserves
replacement-like text in your own arguments (`$&`, `` $` ``, `$'`, `$$`, `$1`,
`$<name>`, `$@`).

| Command | What it does |
| --- | --- |
| `/symvanta-ask [question]` | Answers a behavior question ("how does X work", "why does Y happen", "what triggers Z") from the graph, with file citations. |
| `/symvanta-blast [symbol or path:symbol]` | Runs a blast-radius check before you edit a symbol: what breaks across files, layers, and repositories. Satisfies the pre-edit gate. |
| `/symvanta-trace [symbol]` | Traces a symbol: full call chain, direct callers, and dependencies. |
| `/symvanta-status [repository (optional)]` | Reports connection and index health: bound project, indexed repositories, freshness, graph density, and MCP wiring. The pre-edit gate runs in-process inside the extension, so this snapshot cannot report it. |
| `/symvanta-architecture [repository (optional)]` | Sketches the architecture of the indexed codebase: functional modules, their hubs, cross-module coupling, and the load-bearing functions. |
| `/symvanta-scope [symbol or change description]` | Estimates the scope of a change before you size or plan it, grounded in the graph and its real call sites. |
| `/symvanta-tests [symbol]` | Finds the existing tests that cover a symbol, from the graph. |
| `/symvanta-working-tree [repository (optional)]` | Overlays uncommitted working-tree edits onto a synthetic indexed revision, so graph, text, and symbol tools reflect unpushed changes. |
| `/symvanta-route [route path] [method (optional)]` | Resolves an HTTP route to the handler and middleware that serve it, from framework router metadata. |
| `/symvanta-branch [branch name, or clear (optional)]` | Pins this session's graph reads to a tracked branch, or drops the pin. |
| `/symvanta-recent [path (optional)]` | Lists recent indexed history: the files changing most often and the latest commits, optionally scoped to one path. |
| `/symvanta-clear [branch \| working-tree \| project (optional)]` | Drops the Symvanta session pin: the branch or working-tree revision pin by default, and the project binding only when you ask for it. |

## Agents

The plugin ships two OMP task agents. Dispatch them with the `task` tool by name,
or let the policy in the rule select them for graph-shaped work:

- `symvanta-explorer` takes a first pass over unfamiliar code: binding,
  orientation, symbol and file lookup, behavior questions, HTTP routes, existing
  tests, and architecture. It answers with `filePath:line` citations.
- `symvanta-tracer` follows a symbol: callers, dependencies, blast radius, and
  the full call chain. It checks `freshness` first and labels every edge with
  its confidence tier.

Both agents are read-only: they never edit files and never spawn other agents.

## Status widget

The extension registers an observation-only status line and a below-editor
widget. Both render only what successful `init`, `freshness`, and `index_health`
results already reported in this session: the bound repository, index freshness,
and the indexed repository count. They say nothing until such a result arrives.
A `workspace.attached: false` result shows as `not attached`. The widget does not
change what the agent does.

## How it runs

The runtime is the extension entry (`src/index.ts`), the command-template loader
(`src/commands.js`), and four dependency-free helpers (`src/repository.js`,
`src/impact.js`, `src/augment.js`, `src/status.js`) that a test can import
without a session. The extension registers these handlers:

| Event | What it does |
| --- | --- |
| `session_start` | Reads the checkout's git remote (`git config --get remote.origin.url`, through `execFile` with no shell and a timeout), derives `owner/name`, and injects context telling the agent to call `init` with that `repository`. That binding makes this checkout the default project. For a missing remote or an unindexed checkout, the primer directs local work. Session start sends nothing off the machine. |
| `session_switch` | For `/new` (`reason: new`), repeats the session-start setup inside the same process: requeues the primer, clears the status UI, and resets the gate. For `switch`, `fork`, and `resume`, which load an existing transcript, it does nothing. |
| `before_agent_start` | For symbol-shaped terms in the prompt being prepared, returns one hidden, agent-attributed message naming the graph calls that would resolve them. Silent until an `init` result has observed `workspace.attached: true`. |
| `tool_call` | Applies `SYMVANTA_IMPACT_MODE` to edits and writes. Adds guidance to local searches and code reads without changing those calls. |
| `tool_result` | Tracks in-flight impact checks by tool call id. A successful result satisfies the gate; a pending or failed check cannot authorize an edit, including one in the same batch. The same stream feeds the augmenters and the status widget and records the attachment observation. It never patches a result. |
| `session_shutdown` | Clears this session's gate state and any impact call still pending. |

The extension resolves a bare tool name from host-reported tool metadata and,
failing that, from the wire name with the `mcp__` prefix and any repeated server
token stripped. The remaining name must identify a known Symvanta tool.
`mcp__symvanta_relate`, `mcp__symvanta__relate`, and the marketplace-shaped
`mcp__symvanta_symvanta_relate` all resolve to `relate`, which keeps the gate
armed in every install shape.

Edit targets come from every wire shape the host can send:

- the `path`/`file_path`/`filePath` fields and their plural siblings, and a path
  array;
- patch payloads in each dialect the host emits: the hashline `[path#hash]`
  sections, the `*** Update File:`, `*** Delete File:` and `*** Add File:`
  markers, and the sloppy-mode `*** SM:EDIT path` and `<SM:EDIT path="...">`
  spellings, where the attribute may also be spelled `file=`.

A quoted path, a copied `[path]` or `[path#hash]` wrapper, a `~/` home prefix,
and the OMP path aliases `file:///absolute`, `@/absolute`, `@~/` and
`:/absolute` are normalized before the target is checked. The guard skips
non-file schemes such as `https://` and `xd://`.

The always-apply rule (`rule://symvanta`) carries the standing policy:

- bind with `init`;
- start unfamiliar work with `context`;
- use the graph for an attached, indexed repository;
- check blast radius before editing;
- read the local ranges the graph returned;
- use `lsp` for exact references and refactors;
- check `freshness` before trusting results after a recent push;
- use local tools for an unattached checkout.

The `symvanta` skill holds the full tool decision matrix.

### Direct MCP and the XD write-device bridge

The extension normalizes direct MCP calls and XD writes into one logical call:

- **Direct MCP tools**, whose wire names the host mints
  (`mcp__symvanta_relate`, or the marketplace-shaped
  `mcp__symvanta_symvanta_relate`).
- **XD write devices**, which expose MCP tools as `write` targets: write the
  tool's JSON arguments to `xd://mcp__symvanta_<tool>`.

Ownership is proven at the server segment: a device must name the MCP wire name
the host mints for the Symvanta server itself (`xd://mcp__symvanta_<tool>`, its
`xd://mcp__symvanta__<tool>` separator spelling, or the marketplace-doubled
`xd://mcp__symvanta_symvanta_<tool>`), with a tail the Symvanta tool table
knows. The tail alone proves nothing. A foreign device stays an ordinary write:
`xd://mcp__github_symvanta_relate` belongs to another server, and
`xd://symvanta_relate` or `xd://mcp__notsymvanta_relate` merely share letters.

A device call can also be a schema lookup. Empty or missing content, `?`, and
`help` ask the device to describe itself, and the result may carry
`details.xdev.mode: "help"`. A help-mode result changes nothing, whatever the
outer `write` returned: no status update, no attachment observation, no armed
guard, and no impact check. Malformed JSON content is inert the same way,
because it names no executable arguments. Only a `write` whose content is the
tool's JSON arguments, or an already-parsed argument object, is a real call.

Direct calls and XD writes use the same result handlers. A bridged `init` result
feeds the widget and carries the same `workspace.attached` observation, so it
arms the gate and the augmenters. A bridged `freshness` or `index_health` result
feeds the widget. A bridged `relate` (kind: `blast_radius`) or `estimate_scope`
counts as an impact check, tracked by the outer `write` call id under the same
completion rules. Without mounted MCP definitions, a successful bridged `init`
also marks `relate` and `estimate_scope` available, so the refusal names them.
XD uses OMP's own MCP connection, and the plugin still only reads the results
the host hands it.

### Why the Claude Code hook family is not copied

The Claude Code plugin ships per-tool augmenter hooks that read the stored
Symvanta token from Claude Code's credential store and speak HTTP to the MCP
endpoint themselves, with local caches and a local activity log. Claude Code
hooks run as separate processes, so they cannot call MCP tools through the host.

OMP does not need that shape:

- the extension runs in-process on OMP's event bus, so it observes tool calls
  and adds hidden guidance without spawning a process per tool call;
- MCP auth stays broker-managed by OMP, so the extension holds no token;
- the standing policy lives in an always-apply rule injected into the system
  prompt, so there is no per-tool hook script to audit or to fail.

## Privacy

- No telemetry, no analytics, no background processes, and no daemon.
- The extension makes no network requests at all. It reads the checkout's git
  remote and file extensions locally and talks to OMP through the event bus. The
  augmenters only add text to prompts and tool results, so the plugin never
  fabricates a graph answer.
- Gating and guidance follow the attachment rules under
  [Impact modes](#impact-modes).
- OMP sends agent-requested MCP calls through the HTTPS connection and OAuth
  credential you authorized. Arguments carry identifiers, task descriptions,
  repo-relative paths, and the repository slug. File contents leave the machine
  only when a tool call explicitly asks for them.
- The plugin writes no caches, logs, or state files of its own. Credentials live
  in OMP's auth storage, and uninstall does not touch them.
- The repository is private for now and small enough to read end to end: the six
  modules under `src/` are the entire runtime.

## Uninstall

Each install lane uninstalls under its own identity:

```
omp plugin uninstall @symvanta/omp-plugin                      # direct Git install
omp plugin uninstall --scope project symvanta@symvanta-omp     # marketplace install
```

`omp plugin list` shows the registered name if you are unsure of the spelling.
Uninstall removes the registration and any copy OMP made at install time. A
linked checkout is only unlinked, so its working tree stays on disk. Neither
case removes the OAuth credential. To sign out, run `/mcp unauth symvanta` for a
direct install or `/mcp unauth symvanta:symvanta` for a marketplace install.

## Layout

```
.omp-plugin/marketplace.json   marketplace catalog (symvanta-omp / symvanta, source ./)
.mcp.json                      Symvanta MCP server definition (http, env-overridable URL)
package.json                   omp.extensions manifest
src/index.ts                   extension entry: session context, impact gate, status widget, command registration
src/commands.js                command table and template loading/rendering
src/impact.js                  impact-mode parsing and the refusal policy (pure)
src/augment.js                 guidance-only augmenter notes (pure)
src/status.js                  status line and widget reader (pure)
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

Run the contract validator with `node scripts/validate.mjs`, and the tests with
`node --test`. Both use Node built-ins only and need no install step.

## License

MIT
