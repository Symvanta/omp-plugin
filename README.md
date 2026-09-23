# Symvanta plugin for oh-my-pi (OMP)

Symvanta serves your codebase's call graph over MCP. This plugin wires that graph
into oh-my-pi: it registers the MCP server, binds each session to the checkout
you opened, and gates edits on a real impact check.

Installing it gives you:

- the Symvanta MCP server definition, on Symvanta Cloud by default and
  overridable for staging or on-prem;
- repository binding at session start, so the agent calls `init` with this
  checkout's `owner/name`;
- a pre-edit impact gate with four modes;
- two read-only task agents (`symvanta-explorer`, `symvanta-tracer`), an
  always-apply navigation rule, twelve `/symvanta-*` commands, and the
  `symvanta` skill.

## Requirements

- oh-my-pi with plugin support (`omp plugin --help`).
- A Symvanta account with at least one indexed repository. Without one the
  plugin still installs: the widget shows `not attached`, the gate and the
  augmenters stay silent, and the agent works from local files.

## Install

Two lanes exist. Pick one and use its names throughout.

| | Direct Git install | Marketplace install |
| --- | --- | --- |
| Scope | user-wide | project, with `--scope project` |
| MCP server | `symvanta` | `symvanta:symvanta` |
| Commands | `/symvanta-ask` and the other eleven | the same twelve through the extension aliases, plus the namespaced files `symvanta:symvanta-*` |
| Uninstall | `omp plugin uninstall @symvanta/omp-plugin` | `omp plugin uninstall --scope project symvanta@symvanta-omp` |

### Git install (user-wide)

```
omp plugin install github:Symvanta/omp-plugin
```

The MCP server registers as `symvanta` and the commands as `/symvanta-*`.

The installer honors `--scope` for marketplace installs (`name@marketplace`)
only, so a Git install always lands in the user plugin root. For project-level
control, use the marketplace lane or scope the server definition itself:

```
/mcp add symvanta --url <endpoint> --scope project
```

`omp plugin list` shows registered plugins. `omp plugin doctor` reports drift
and `omp plugin doctor --fix` repairs it.

### Marketplace install (project-scoped)

The repository ships a catalog at `.omp-plugin/marketplace.json`, marketplace
`symvanta-omp`, plugin `symvanta`:

```
omp plugin marketplace add Symvanta/omp-plugin
omp plugin install --scope project symvanta@symvanta-omp
```

A project-scoped install lives in `<project>/.omp/plugins/` and shadows a
user-scoped install of the same plugin ID. In-session equivalents:
`/marketplace add Symvanta/omp-plugin`, then
`/marketplace install --scope project symvanta@symvanta-omp`.

Marketplace installs go through OMP's name rewriting, so read
[Marketplace namespacing](#marketplace-namespacing) first.

### Local checkout (development)

```
omp plugin link /path/to/omp-plugin
```

`omp plugin link` symlinks the checkout into the user plugin root, so the next
reload loads your working tree. No reinstall step.

## Marketplace namespacing

A marketplace install prefixes every command and MCP server name with the plugin
name. A Git install keeps the plain names. For plugin `symvanta` from marketplace
`symvanta-omp`:

- the server in `.mcp.json` (`symvanta`) registers as `symvanta:symvanta`, so
  `/mcp` subcommands take that name: `/mcp test symvanta:symvanta`,
  `/mcp reauth symvanta:symvanta`, `/mcp unauth symvanta:symvanta`;
- the markdown commands in `commands/` register as `symvanta:symvanta-ask`,
  `symvanta:symvanta-blast`, and so on;
- the extension registers aliases for all twelve stable `/symvanta-*` names, so
  those keep working in both lanes. Extension commands take precedence, and the
  namespaced files stay available.

`/mcp list` shows server names and `/reload-plugins` lists command names.

## Reload and restart

| Change | What picks it up |
| --- | --- |
| Skills, slash commands, MCP servers | `/reload-plugins` |
| The extension (session context, gate, widget, command aliases) | restart the session |
| MCP server definitions only | `/mcp reload`, or `/mcp reconnect <server>` |

Install, link, and uninstall change disk state without rebuilding the session
you are in, and no file watcher sits behind commands or skills.

## Sign in (OAuth)

Every Symvanta server advertises its own OAuth endpoints, so OMP opens the
browser sign-in on first connection. The plugin needs no OAuth configuration.
OMP stores and refreshes the credential, keyed to the server URL.

```
/mcp list                        # server name for your lane
/mcp test symvanta               # Git install
/mcp test symvanta:symvanta      # marketplace install
/mcp reconnect symvanta          # reconnect without rediscovering every config
/mcp reauth symvanta             # replace the stored OAuth credential
/mcp unauth symvanta             # remove the stored credential
```

After a credential expiry, an account switch, or a `SYMVANTA_MCP_URL` change, run
`/mcp reauth <server>`: each URL binds its own credential. On a marketplace
install, `<server>` is `symvanta:symvanta`.

## Configuration

### Server URL

The entry ships `${SYMVANTA_MCP_URL:-https://mcp.symvanta.com/mcp}`, which OMP
expands at discovery time. Export the full URL before launching oh-my-pi to use
staging or an on-prem server:

```
export SYMVANTA_MCP_URL=https://mcp.your-company.com/mcp
omp
```

Include the `/mcp` path, with no trailing slash. Run `/mcp reload` after changing
it, and re-authorize if the URL changed.

### Impact modes

`SYMVANTA_IMPACT_MODE` sets how hard the pre-edit gate pushes. Values are trimmed
and case-insensitive; a missing or unknown value means `once`.

| Mode | Behavior |
| --- | --- |
| `once` (default) | Refuses the first unchecked `edit` or `write` of existing code, then fails open. A successful `relate` (kind: `blast_radius`) or `estimate_scope` call satisfies the gate for the rest of the session. |
| `strict` | Refuses every `edit` or `write` of existing code until an impact check succeeds, and never stops refusing, so an unresponsive server leaves the mutation refused. |
| `warn` | Never blocks. An unchecked edit of existing code runs, with one hidden note per file naming the check that would have covered it. |
| `off` | No gating, no note. |

The gate acts only on a checkout Symvanta has confirmed: it activates on a
successful `init` result reporting `workspace.attached: true`, stays silent on
`workspace.attached: false`, and only `init` changes that state. New files and
non-code files always pass, and the gate is per session.

### Guidance augmenters

The extension can add hidden, guidance-only context: a prompt primer, one note
after a local search or a file read, and a rescue when a `grep` finds nothing
(call `locate` with no mode so it routes to semantic search). The read note is
keyed per file, so selectors such as `:50+150` do not draw a second note. A
`No more results` page means an earlier page did match, so it is not an empty
search. The prompt note is deterministic: the same submission gets the same
note. Augmenters add text only, the agent decides whether to call a tool, and
they follow the same attachment rule as the gate.

Switches are trimmed and case-insensitive; `off`, `false`, `0`, or `no`
disables:

| Variable | Turns off |
| --- | --- |
| `SYMVANTA_AUGMENT` | every augmenter below |
| `SYMVANTA_AUGMENT_PROMPT` | the prompt routing note |
| `SYMVANTA_AUGMENT_SEARCH` | the search note |
| `SYMVANTA_AUGMENT_READ` | the first-read note |
| `SYMVANTA_AUGMENT_RESCUE` | the empty-`grep` rescue |
| `SYMVANTA_AUGMENT_DEDUPE` | the tool-guidance dedupe, including `warn` notes |

The gate and the status widget ignore these switches, except the dedupe switch,
which also governs repeated `warn` notes.

### Timeout

The server entry sets a 120000 ms timeout, because graph queries run longer than
a chat round trip. `OMP_MCP_TIMEOUT_MS` overrides every per-server timeout, and
`0` disables client-side MCP timeouts.

## Commands

Each command routes to a graph tool, so you do not have to remember tool names.
The extension registers all twelve in both lanes.

Arguments are inserted literally: the extension replaces the template's
`$ARGUMENTS` (or `$@`) placeholder once and leaves replacement-like text (`$&`,
`` $` ``, `$'`, `$$`, `$1`, `$<name>`, `$@`) in your own arguments alone.

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

Two read-only task agents. Dispatch them by name with the `task` tool, or let the
rule's policy pick them for graph-shaped work:

- `symvanta-explorer` orients on unfamiliar code: binding, symbol and file
  lookup, behavior questions, HTTP routes, tests, and architecture.
- `symvanta-tracer` follows a symbol: callers, dependencies, blast radius, and
  the full call chain, with `freshness` checked first.

Neither agent edits files or spawns other agents.

## Status widget

The extension registers an observation-only status line and a below-editor
widget. Both render only what `init`, `freshness`, and `index_health` results
already reported in this session: bound repository, index freshness, and indexed
repository count. A `workspace.attached: false` result shows as `not attached`.
The widget changes nothing about agent behavior.

## Runtime notes

The extension reads the checkout's git remote at session start to build the
`init` binding, repeats that setup for `/new` (an empty transcript in the same
process), and clears its state at shutdown.

Symvanta tool names resolve from host metadata, or from the wire name once
`mcp__` and any repeated server token are stripped, so `mcp__symvanta_relate`,
`mcp__symvanta__relate`, and `mcp__symvanta_symvanta_relate` all work.

### XD write devices

When the harness mounts no MCP tools and exposes them as `write` targets, write
the JSON arguments to `xd://mcp__symvanta_<tool>`.

Ownership is proven at the server segment: the device must name the Symvanta
server (`xd://mcp__symvanta_<tool>`, `xd://mcp__symvanta__<tool>`, or the
marketplace-doubled `xd://mcp__symvanta_symvanta_<tool>`) with a tail the tool
table knows. A foreign device stays an ordinary write.

Content that is empty, `?`, or `help` is a schema lookup. Such a result reports
`details.xdev.mode: "help"` and changes nothing: no widget update, no attachment
observation, no armed gate, no impact check. Malformed JSON is inert the same way.

## Privacy

- No telemetry, no analytics, no background processes, no daemon.
- The extension makes no network requests. It reads the git remote and file
  extensions locally and talks to OMP through the event bus.
- MCP calls are the agent's own, over the HTTPS connection and OAuth credential
  you authorized. Arguments carry identifiers, task descriptions, repo-relative
  paths, and the repository slug; file contents leave the machine only when a
  tool call asks for them.
- The plugin writes no caches, logs, or state files. Credentials live in OMP's
  auth storage, and uninstall leaves them alone.

## Uninstall

```
omp plugin uninstall @symvanta/omp-plugin                      # Git install
omp plugin uninstall --scope project symvanta@symvanta-omp     # marketplace install
```

`omp plugin list` shows the registered name if the spelling is unclear. A linked
checkout is only unlinked, so its working tree stays on disk. Neither case
removes the OAuth credential: run `/mcp unauth symvanta` or
`/mcp unauth symvanta:symvanta` to sign out.

## Layout

```
.omp-plugin/marketplace.json   marketplace catalog
.mcp.json                      Symvanta MCP server definition
package.json                   omp.extensions manifest
src/index.ts                   extension: session context, gate, widget, commands
src/commands.js                command table and template rendering
src/repository.js              git-remote parsing and startup context (pure)
src/impact.js                  impact modes and the refusal policy (pure)
src/augment.js                 guidance-only augmenter notes (pure)
src/status.js                  status line and widget reader (pure)
rules/symvanta.md              always-apply navigation policy (rule://symvanta)
commands/symvanta-*.md         the twelve slash commands
agents/symvanta-*.md           the explorer and tracer task agents
skills/symvanta/SKILL.md       tool decision matrix
scripts/validate.mjs           contract validator
test/validate.test.mjs         validator contract tests
test/extension.test.mjs        extension behavior tests
test/repository.test.mjs       startup-context and git-remote parsing tests
```

Run the contract validator with `node scripts/validate.mjs` and the tests with
`node --test`. Both need no install step.

## License

MIT
