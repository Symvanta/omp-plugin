# Symvanta plugin for oh-my-pi (OMP)

One-step setup for working in a [Symvanta](https://symvanta.com)-indexed codebase
under oh-my-pi. Installing this plugin:

- registers the Symvanta code-graph MCP server for you (Cloud endpoint by
  default, overridable for staging or on-prem), so you never hand-edit an MCP
  config;
- injects repository binding context at session start, so the agent calls `init`
  with this checkout's `owner/name` instead of guessing which project to read;
- gates the first edit of existing code on a real impact check, so a change lands
  only after `relate` (kind:blast_radius) or `estimate_scope` has completed
  successfully for it;
- ships an always-apply navigation rule, eight `/symvanta-*` commands, and the
  `symvanta` skill, so graph-first navigation is the default path rather than an
  option you have to remember.

## Requirements

- oh-my-pi with plugin support (`omp plugin --help` lists the actions this
  README uses).
- A Symvanta account whose workspace has at least one repository indexed. An
  account with no indexed repository still installs cleanly: the plugin degrades
  to plain local work and says so instead of inventing results.

## Install

### From GitHub (recommended)

```
omp plugin install github:Symvanta/omp-plugin
```

Installing straight from the repository is what makes the names in this README
the names you get: the MCP server registers as `symvanta` and the commands
register as `/symvanta-*`, unchanged.

A Git install is user-wide. The plugin lands in the user-wide plugin root and
loads from every checkout, and the installer's `--scope` flag is honored only for
marketplace installs (`name@marketplace`), so adding a project scope to a Git
install changes nothing. Where project-level control is wanted, MCP server
definitions are the scope-aware part of OMP:
`/mcp add symvanta --url <endpoint> --scope project` and
`/mcp remove symvanta --scope project` act on the project scope, while installing
or removing the plugin itself always acts on the user plugin root.

`omp plugin list` shows the registered plugins, and `omp plugin doctor` reports
drift in plugin state (`omp plugin doctor --fix` repairs what it can).

### Why this release ships no marketplace catalog

Marketplace installs route a plugin through OMP's namespace rewriting, which
prefixes the command and MCP server names it registers. A catalog entry would
therefore install commands that are not the `/symvanta-*` commands and a server
that is not the `symvanta` server documented here, and every name below would be
wrong for a marketplace user. This release ships no catalog: install from GitHub
(above) or link a checkout (below). A catalog may only return alongside an
explicit `## Marketplace namespacing` section documenting the rewritten names,
which `scripts/validate.mjs` enforces.

### From a local checkout (development)

```
omp plugin link /path/to/omp-plugin
```

`omp plugin link` symlinks the checkout into the user plugin root instead of
copying it, so edits in the working tree are what the next reload loads. There is
no cached copy to update and no reinstall step.

## Reload and restart

Plugin state is read at defined points, not continuously:

| Change | What picks it up |
| --- | --- |
| Skills, slash commands, MCP servers | `/reload-plugins` |
| The extension module (session-start context, session-switch primer, pre-edit gate) | restart the session |
| MCP server definitions only | `/mcp reload`, or `/mcp reconnect symvanta` |

`omp plugin install`, `omp plugin link`, and `omp plugin uninstall` mutate disk
state and invalidate discovery caches; they do not rebuild the session you are
sitting in. Run `/reload-plugins` after an install or upgrade, and restart the
session the first time so the extension module loads. There is no file watcher
behind slash commands or skills.

## Sign in (OAuth)

Every Symvanta MCP server (Cloud, staging, or on-prem) advertises its own OAuth
endpoints, so OMP runs the browser sign-in on first connection and there is
nothing to configure in the plugin. The credential is stored by OMP's auth
storage or broker, keyed to the server URL, and refreshed by OMP itself.

```
/mcp list                  # confirm the symvanta server and which config it came from
/mcp test symvanta         # connect now and list the tools it serves
/mcp reconnect symvanta    # reconnect this server without rediscovering every config
/mcp reauth symvanta       # replace the stored OAuth credential
/mcp unauth symvanta       # remove the stored credential
```

Run `/mcp reauth symvanta` after a credential expires, after signing in as a
different account, or after changing `SYMVANTA_MCP_URL` (a new URL is a new
credential binding).

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

### Turn the pre-edit gate off

The impact gate blocks only the first edit or write of existing code until an
impact check has completed successfully in that session. It is per session, not
per turn: once a check succeeds, later edits in the same session are ungated. To
disable it entirely (it then never blocks anything):

```
export SYMVANTA_ENFORCE_IMPACT=off
```

### Timeout

The server entry sets a 120000 ms request timeout, because architecture and
blast-radius queries over a large graph take longer than a chat round trip.
`OMP_MCP_TIMEOUT_MS` takes process-wide precedence over every per-server timeout
if you need to raise it further, or set it to `0` to disable client-side MCP
timeouts.

## Commands

Each command routes to the right graph tool so you do not have to remember tool
names:

| Command | What it does |
| --- | --- |
| `/symvanta-ask [question]` | Answer a behavior question ("how does X work", "why does Y happen") from the graph, with file citations. |
| `/symvanta-blast [symbol]` | Blast-radius check before editing a symbol: what breaks across files, layers, and repositories. Satisfies the pre-edit gate. |
| `/symvanta-trace [symbol]` | Full call chain, direct callers, and dependencies of a symbol. |
| `/symvanta-status [repository]` | Bound project, indexed repositories, freshness, and graph density. The pre-edit gate lives inside the extension process, so the command reports it as in-process state rather than querying it. |
| `/symvanta-architecture [repository]` | Functional modules, their hubs, cross-module coupling, and the load-bearing functions. |
| `/symvanta-scope [symbol or change]` | Pre-flight scope estimate for a change, grounded in the graph instead of guessed call sites. |
| `/symvanta-tests [symbol]` | The existing tests that cover a symbol. |
| `/symvanta-working-tree [repository]` | Overlay uncommitted edits so graph, text, and symbol tools reflect unpushed work. |

## What runs at runtime

The plugin is one extension module (`src/index.ts`) plus a pure helper
(`src/repository.js`), a rule, eight commands, and a skill. It registers five
event handlers:

- **`session_start`** reads the checkout's git remote (`git config --get
  remote.origin.url`, via `execFile` with no shell and a timeout), derives
  `owner/name`, and injects context that tells the agent to call `init` with that
  `repository`. That binding is what makes "the default project" this checkout
  rather than some other codebase in the workspace. With no remote, or when the
  checkout is not indexed, the injected text says so and the agent is told to
  work without the graph. Nothing is sent anywhere at session start.
- **`session_switch`** re-runs the session-start routine when the switch reason
  is `new`, which is what `/new` emits when the runtime swaps in an empty
  transcript inside the same process: the primer is queued again and the guard
  starts over, so a fresh conversation neither loses the binding nor inherits the
  previous transcript's satisfied gate. Other reasons (`switch`, `fork`,
  `resume`) carry the transcript they loaded, so nothing is reissued for them.
- **`tool_call`** watches the agent's own tool calls. It blocks **one** thing: the
  first `edit`/`write` that would modify existing code, when no impact check has
  completed yet in this session. Once a `relate` (kind:blast_radius) or
  `estimate_scope` call finishes successfully, the gate opens for the rest of the
  session; a check that is still running, or one that failed, does not open it.
  New files and non-code files pass untouched, and if the graph is unreachable
  (no Symvanta tools, server down) the gate fails open rather than wedging the
  session. `SYMVANTA_ENFORCE_IMPACT=off` disables it. Edit targets are read from
  every wire shape the host can send: the `path`/`file_path`/`filePath` fields
  and their plural siblings, a path array, and patch payloads in each dialect the
  host emits, the hashline `[path#hash]` sections, the `*** Update File:`,
  `*** Delete File:` and `*** Add File:` markers, and the sloppy-mode
  `*** SM:EDIT path` and `<SM:EDIT path="...">` spellings (the attribute may also
  be spelled `file=`). A quoted path, a copied `[path]` or `[path#hash]` wrapper,
  a `~/` home prefix, and the OMP path aliases `file:///absolute`, `@/absolute`,
  `@~/` and `:/absolute` are all normalized before the target is checked; a
  target that names a non-file scheme (`https://`, `xd://`) is skipped instead of
  being resolved against the checkout.
- **`tool_result`** decides whether that check counted. It tracks impact calls by
  tool call id while they are in flight and opens the gate only for one that
  completed successfully, so a check issued in the same batch as an edit cannot
  wave that edit through, and a failed check leaves the gate shut. It never
  patches a result.
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

### Why the Claude Code hook family is not copied

The Claude Code plugin ships per-tool "augmenter" hooks that read the stored
Symvanta token from Claude Code's credential store and speak HTTP to the MCP
endpoint themselves, with local caches and a local activity log. That shape
exists because Claude Code hooks are separate processes that cannot call MCP
tools through the host.

OMP does not need it, and this plugin deliberately does not reproduce it:

- the extension runs in-process on OMP's event bus, so it can observe tool calls
  (the pre-edit gate) without spawning a process per tool call;
- MCP auth stays broker-managed by OMP: the extension never reads a credential
  file, never holds a token, and never makes a direct HTTP request;
- the standing policy lives in an always-apply rule, which is injected into the
  system prompt, so there is no per-tool hook script to audit or to fail.

## Privacy

- No telemetry, no analytics, no background processes, and no daemon.
- The extension makes no network requests at all. It reads the checkout's git
  remote and file extensions locally, and talks to OMP through the event bus.
- Every graph query is an MCP tool call the agent decides to make, over the same
  HTTPS connection and OAuth credential you authorized, through OMP's MCP client.
  What leaves the machine is exactly those tool arguments (identifiers, task
  descriptions, repo-relative paths, the repository slug), never file contents
  unless a tool call explicitly asks for them.
- The plugin writes no caches, logs, or state files of its own. Credentials live
  in OMP's auth storage; uninstall does not touch them (see below).
- The repository is public and small enough to read end to end: `src/index.ts`
  and `src/repository.js` are the entire runtime.

## Uninstall

Both install paths register the plugin under its package name, so one command
removes it:

```
omp plugin uninstall @symvanta/omp-plugin
```

`omp plugin list` shows the registered name if you are unsure of the spelling.
Uninstall removes the registration and any copy OMP made at install time; a
linked checkout is only unlinked, so its working tree stays on disk. Neither case
removes the OAuth credential: drop it with `/mcp unauth symvanta` if you also
want to sign out.

## Layout

```
.mcp.json                      Symvanta MCP server definition (http, env-overridable URL)
package.json                   omp.extensions manifest
src/index.ts                   session_start context, session-switch primer, pre-edit impact gate
src/repository.js              git-remote parsing and startup-context text (pure)
rules/symvanta.md              always-apply navigation policy (rule://symvanta)
commands/symvanta-*.md         the eight slash commands
skills/symvanta/SKILL.md       tool decision matrix and conventions
scripts/validate.mjs           dependency-free contract validator
test/validate.test.mjs         validator contract tests and the extension's static contract
test/repository.test.mjs       startup-context and git-remote parsing tests
```

There is no `.omp-plugin/marketplace.json`: this release is installed from the
repository itself, so the catalog entry (and the namespace rewriting it triggers)
is not shipped.

Run the contract validator with `node scripts/validate.mjs`; run the tests with
`node --test`. Both use Node built-ins only and need no install step.

## License

MIT
