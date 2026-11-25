# dsh-mcp-lazy

Progressive disclosure for MCP servers on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

> **Something broken?** Jump to [Maintenance](#maintenance-five-minute-repair):
> one self-check command, a symptom table, and how to reload after editing code.

Every MCP tool that `@deepseek-ai/dsh-mcp-client` connects is registered as a full
model-facing tool definition and sent on every request. A busy server such as REA
(207 tools) costs ~47k tokens of static context *before* the model does anything.
This bundle keeps the MCP surface down to **one line per server plus one meta
tool**, and loads a server's real tools only when the agent asks for them.

## What it does

- **Stable one-line catalog** in the prompt: `- rea: reverse engineering (207 tools)`.
- **One meta tool** (`mcp`) with `list` / `load` / `unload`.
- **`load`** lifts the per-agent restriction on exactly that server. Its real
  tools then enter the request through DSH's native tool-addition path, with
  their full parameter schemas, and are called natively afterwards (normal
  validation, approvals, guards, timeouts, parallel scheduling).
- **Self-healing calls.** A global `ctx.tools.guard()` intercepts a call to a
  hidden tool (stale history after `unload`, a typo, or a server added
  mid-conversation) and returns the exact `load` call to make instead of a bare
  `UNKNOWN_TOOL`. `mcp list` also reports the estimated schema tokens being kept
  out of context.
- **New MCP servers follow the pattern automatically.** The plugin rebuilds its
  index on `tools/change`; any newly registered `mcp__<server>__*` server is
  hidden on the next assembly and gets its own catalog line (summary defaults to
  `N tools`; add `servers.<name>` for a better one-line purpose).
- **No dispatcher, no MCP reimplementation, no `system-prompt/assemble` rewrite.**
  Connection, reconnect, resources, and image handling stay in `dsh-mcp-client`.

## How the agent knows

1. The stable prompt catalog (a runtime context by default) states the rule:
   MCP tools are hidden until loaded, call `load` before `mcp__<server>__`, and
   never claim an MCP capability is unavailable before loading it.
2. The `mcp` tool description repeats the call order and the next-step rule.
3. Hidden tools are absent from the request. A guessed or stale call is caught
   by the global `ctx.tools.guard()` and answered with the exact `load` call.
4. `mcp list` reports per-agent state and the estimated schema tokens being kept
   out of context.
5. A newly registered MCP server appears in the catalog and is hidden at the
   next assembly; the default `minTools: 1` means the pattern applies without
   configuration.

## Adding another MCP server

Add the server the usual way — a `@deepseek-ai/dsh-mcp-client` row, normally
through a configuration-only bundle. No code change is needed:

- On the next assembly the plugin sees the new `mcp__<server>__*` tools through
  `tools/change`, hides them (`minTools: 1` by default), and adds a catalog line
  `- <server>: N tools`.
- Add `servers.<server>: "one-line purpose"` to the `mcp-lazy` config for a
  better catalog line; otherwise the server's own instructions are used (see
  below), and the count is the last fallback.
- If the model calls one of the new tools before loading it, the guard answers
  with the exact `load` call.

### Who writes the summary?

Priority order:

1. `servers.<server>` in the plugin config — the human/agent override.
2. **The MCP server's own instructions.** `dsh-mcp-client` already injects a
   `mcp:<server>` prompt section; the plugin reads it during assembly and takes
   its first sentence as the catalog summary (`autoSummary: true` by default).
   No LLM call and no separate script.
3. `N tools` when the server provides no instructions and no config summary.

The instruction source is `dsh-mcp-client`'s `mcp:<server>` prompt section. If
that section is absent (the server has no instructions, or a future bridge
changes the name), the fallback is `N tools`; a configured `servers.<server>`
summary still works.

If the automatic sentence is poor, the agent installing the server can call
`mcp list`, inspect the tools, and add a better one-line `servers.<server>`.

Verified on the reference machine with a fresh subagent: a hidden
`mcp__rea__list_documents` call returned
`Error: MCP server "rea" is lazy-loaded: ... Call mcp({action:"load",server:"rea"}) first`,
the load made it dispatch next step, and `unload` brought the same hint back.

### Start without waiting for MCP (`dsh-mcp-lazy/async`)

`@deepseek-ai/dsh-mcp-client` awaits `connection.ready` inside its own `apply`:
by design, activating that plugin waits for the initial connection and the
first tool sync. The desktop shell only shows its window once the whole plugin
tree is assembled, so **any slow MCP server delays the window** — a
streamable-http server whose TCP handshake stalls on a cold boot used to hold
the UI back for the length of the timeout.

This package therefore ships a wrapper row, `dsh-mcp-lazy/async`. It keeps the
client's config schema, tool names, reconnect policy, and `serverName`
reservation, but starts `ctx.plugin(client, config)` on a child fiber without
awaiting it. As a result:

- the Host finishes booting and the window appears without waiting for MCP;
- the server keeps connecting in the background and registers its tools the
  moment it succeeds, so `mcp load` behaves exactly as before;
- the panel shows "First connection…" meanwhile, driven by the real phase from
  `connectionStatusOf()` (`loading` / `starting` / `connecting`), not a timer;
- timeouts and reconnects are unchanged: `startupTimeoutMs` and
  `failOnStartupError` still mean what the client's README says they mean.

Switch a row from `@deepseek-ai/dsh-mcp-client` to `dsh-mcp-lazy/async` to opt
in; the `config` stays as it is:

```yaml
- id: github-mcp
  name: dsh-mcp-lazy/async
  config:
    serverName: github
    transport: streamable-http
    url: https://api.githubcopilot.com/mcp/
    startupTimeoutMs: 7000
    failOnStartupError: false
```

Reverting is the same edit in reverse, then a restart.

Background, measurements and the exact code path: [docs/mcp-async-decoupling.md](docs/mcp-async-decoupling.md).

## Why this is upgrade-safe

The plugin only uses documented Host services:

| Need | API |
| --- | --- |
| Enumerate live agents | `ctx.agents.list()` |
| Per-agent tool visibility | `agent.ctx.tools.restrict({ deny })` |
| Current MCP registry | `ctx.tools.schemas()` |
| Stable catalog | `ctx.systemPrompt.section()` (or `.context()`) |
| React to registry changes | `tools/change` event |
| Agent lifecycle | `agent/created`, `agent/disposed` |
| Tools actually admitted this step | `context.toolSet.view(context.scope)` (second argument of `system-prompt/assemble`) |

**One stated exception:** enumerating "MCP client rows" uses
`ctx.loader.entries()` — a public object of the Cordis loader, but `entries()`
is not a documented DSH service method. It only feeds the registry mirror and the
panel; if it is unavailable the plugin degrades to "register only servers that
have tools", and lazy loading is unaffected.

If any of these disappears, the plugin **fails open**: it logs a warning and
leaves every tool visible instead of breaking a session. Nothing is written into
the DSH installation, so a DSH update replaces `app.asar` but not this bundle.

### No scripts, no DSH edits

- Nothing under the DSH installation is modified. `plugin_manager` only records
  the bundle in the profile's `package.json` and lockfile; a DSH update replaces
  `app.asar` and leaves the profile bundle intact.
- There is no watcher script, cron job, or file outside the package. The only
  triggers are Host events handled inside `index.js` (`tools/change`,
  `agent/created`, `agent/disposed`, `system-prompt/assemble`) plus one `unref`'d
  interval for the health monitor, which never keeps the process alive.
- Every trigger recomputes the catalog from `ctx.tools.schemas()`. There is no
  per-tool registration list to append to: new tools are included because the
  policy is evaluated over the whole registry each time.
- If the plugin is disabled, uninstalled, or fails to load, all tools are
  visible (fail-open), not silently hidden.
- If a `complete` persona or a prompt API change drops the catalog while tools
  are hidden, the `system-prompt/assemble` self-check logs and fails open. The
  default `catalogPlacement: context` already survives complete personas.
- A pull audit in the same listener compares the tools actually admitted this
  step (`context.toolSet.view(context.scope)`) with the index and refreshes when
  a managed tool slipped in before `tools/change` was observed, so a missed event
  costs at most one step.

## Registry mirror and health

Lazy loading itself needs neither. These exist for **"this server should be
here and is gone"** and **"it is still here but it is dead"**.

### Registry mirror (`expectedFile`)

- Written on Host start, on every index rebuild, and on every background health
  pass — **not** only when the settings page is opened.
- Holds name, summary, transport, `firstSeen`, `lastSeen`, merged from three
  sources: MCP client loader rows, registered tools, and the previous mirror.
- Append-only: a server that disappears stays recorded and is shown as
  **Missing**. When it is truly unwanted, press **Forget** in the panel or
  `POST /mcp-lazy/forget` (tombstones only; a server that is still configured or
  still registering tools returns 409).
- The `lastSeen` heartbeat is throttled by `expectedTouchMs` (default 5 min), so
  the panel's 5 s polling does not rewrite the file every time.

### How health is inferred

The DSH MCP client exposes no health API (no service, no events; connection
errors only reach the logger), so the verdict is folded from three kinds of
evidence:

| Evidence | Meaning | Strength |
| --- | --- | --- |
| Tools still registered | It connected at least once | baseline |
| Latest tool call failed with transport wording | Truly unreachable (the only signal stdio can give) | highest |
| HTTP HEAD probe (streamable-http only) | Endpoint answers; any non-5xx counts as reachable | supporting, needs two consecutive misses |

Ranking: call failure > two consecutive probe failures > tools present means
healthy. With no tools, the server is **Connecting** inside the start-up grace,
then **Unavailable**; a reachable endpoint with zero tools is **Reachable, no
tools** (usually the server refused to register, or everything was filtered).
Call-failure evidence expires after `failureTtlMs` (default 5 min), and one
successful call immediately clears both the failure record and the probe cache.

Why two probe misses: a HEAD request never opens an MCP session, so a proxy
hiccup, a DNS timeout or a token that expired a second ago can all produce one
failure. The first miss keeps the verdict (its `probeStatus` still shows `0` for
debugging); only the second one in a row marks a tool-bearing server down.

The background pass is controlled by `healthMonitorMs` (default 30000, `0`
disables, minimum 5000). It adds no permissions and does not touch MCP
connections; it only recomputes and remembers the verdict.

### Registry-wide mode (`scope: "all"`)

DSH does not let one plugin mutate another plugin's registrations. The strongest
supported authority is the per-agent `ctx.tools.restrict()` mask over the whole
global registry. `scope: "all"` applies that authority to **every** global tool
outside `core` (and the meta tool):

- MCP tools keep their `mcp__<server>__` group; every other managed tool joins
  the `other` group.
- `mcp load other` reveals all non-MCP long-tail tools; `core` keeps the working
  set (`read`, `write`, `edit`, `pwsh`, `skill`, …) directly visible.
- A new tool from **any** plugin, MCP or not, is included on the next recompute
  and hidden by default. This is the "registry-wide" version of the policy.
- Trade-off: a too-small `core` can hide something the agent needs immediately.
  The default `scope: "mcp"` is the conservative setting; enable `all` only
  with a curated core list.

### Why not `deferLoading`?

DSH already has `ToolSchema.deferLoading` and the matching `defer_loading` /
`tool_addition` wire path. But `dsh-mcp-client` registers every tool itself and
exposes no defer switch, and a plugin cannot mutate another plugin's
registrations. Hiding through the documented `ctx.tools.restrict()` Service and
lifting that deny set to produce a native tool addition is the closest official
route: it needs no `system-prompt/assemble` rewrite, no dispatcher, and no
private API. The three small MCP resource tools (`list_mcp_resources`,
`list_mcp_resource_templates`, `read_mcp_resource`) stay resident.

## Settings page (Web)

Settings → **MCP** is the visible management surface for the same bundle:

- The server **name** is the emphasized line; the **summary** is the secondary
  line and is rendered from the exact string the catalog uses for the agent
  (`summaryOf(entry, config)`), not from a separate description.
- Tool count and estimated schema tokens are secondary metadata.
- **One source of truth for state.** The Host hands the five inputs (configured
  rows, the live registry, `expectedFile`, health, per-server switches) to the pure
  function `buildInventory()`, and every server gets exactly **one** `status`; the
  panel only maps that status to a badge: `active` (normal lazy disclosure, **no
  badge**), `connecting`, `down` (with `reason` = `call-failed` / `unreachable` /
  `no-tools` / `unavailable`), `always-visible` (amber, **Disclosure inactive**),
  `unconfigured` (tools registered but no configuration row claims them, amber),
  `unknown` (**could not read** the MCP configuration, amber), and `removed`
  (red, **Missing**). The verdicts come from the background pass
  (`healthMonitorMs`); the page only reads them.
- **"No servers configured" and "cannot read the configuration" are now
  different answers.** When the loader scan throws, a red banner appears at the
  top of the page ("Could not read the MCP configuration: …") and the affected
  rows are **Config unreadable (`unknown`)**, instead of every remembered server
  being reported as deleted. A `removed` verdict is only reachable while the scan
  itself succeeded.
- Streamable HTTP servers are actively probed with a side-effect-free HEAD
  request. Any non-5xx answer counts as reachable, so a probe-specific 401/403
  from a WAF or session rule does not turn a working bridge red. A probe must
  fail **twice in a row** before a server is called down, so one blip cannot
  paint a healthy 46-tool server red. Stdio disconnects are detected from the
  next failed tool call (the bridge keeps stale tool definitions); that shows as
  **Connection error**.
- A **Missing** row offers only **Forget** (no switch): the row is not configured
  any more, so a disclosure switch would have nothing to control. `unconfigured`
  and `unknown` rows have no switch either.
- The page has per-server switches. Adding or removing an MCP row itself still
  uses the profile configuration (the panel does not install plugins).
- **Plugin-panel boundary:** MCP servers are profile rows
  (`@deepseek-ai/dsh-mcp-client`), not bundles. The plugin panel lists plugins
  only. Do not install an MCP server as its own bundle, or it will show up in
  the plugin panel.
- **Missing rows (expected servers):** every MCP server the Host has ever seen is
  kept in `expectedFile` (default `~/.dsh/mcp-lazy-expected.json`; `""`
  disables), written on start, on index rebuilds, and on each health pass. A
  remembered server whose row has disappeared from every configuration layer —
  the usual cause is an editor that rewrites the whole `cordis.patch.yml` instead
  of editing it — is still listed, with a red **Missing** badge and
  `reason: configured-missing`, instead of silently vanishing from the panel.
  The mirror is append-only; a tombstone can be removed with **Forget**, which
  is refused for any server that still exists.
- **Per-server switch:** the MCP panel switch controls agent disclosure only.
  Off hides the catalog line and every tool while the connection stays up. State
  is stored at `stateFile` (bundle default `~/.dsh/mcp-lazy-state.json`) and
  survives a restart.
- Data comes from `GET /mcp-lazy/servers`; the switch calls loopback
  `POST /mcp-lazy/toggle`; headless profiles do not expose either.
- The page is a Client half of the same package (`client.js`, `dsh.client`).
  **The client module graph is read at Host boot.** The first time this bundle
  gains a `dsh.client` declaration, restart DSH and refresh the page; later
  client-only changes reload through the Client HMR receiver only when the
  deployment runs its dev client build.

## Cache behaviour

DSH's request-header diff turns tool additions into `tool_addition` developer
messages and appends the new definitions with `defer_loading: true`. The official
real-provider e2e test asserts that the first request after an addition still
reuses the preceding conversation prefix (`cacheReadTokens >= preceding input −
256`). `load` uses exactly that path, so it does **not** re-read the conversation.

Measured on a real DSH session (253 tools, 207 MCP):

| Metric | Before | With lazy MCP |
| --- | ---: | ---: |
| Tool definitions | 238,322 B | ~50,600 B raw, or ~0 MCP when hidden |
| First request total input | 71,138 tokens | ~24,000 tokens |
| First request cache read | 65,408 tokens | ~18,000 tokens |
| Per-step cached prefix | 368,896 tokens | ~321,900 tokens |

The *hit ratio* can look lower (`92%` → `~76%` at the first request) because the
static prefix shrank faster than the variable part. The useful number is the
absolute cached-token volume and the context window freed, both of which drop by
~47k tokens per request.

Caveats:

- **Install at a session boundary.** Hiding tools in an already-running session
  is a *removal* for the header diff; that request may miss the cache once.
- **`unload` may cost one cache miss.** Removals are not covered by the official
  addition guarantee. Use it sparingly.
- Routes without `toolUpdate` (for example `pi-ai`) fall back to a prompt merge
  when the surface changes; `deepseek-flash` uses `addition-only` and is fine.

Verified on the reference machine with a fresh subagent: it started at 41 tools
(47,409 B). `load` added the 207 REA tools and cost 51,723 uncached input tokens
on that one request; the next requests read 71,424 cached tokens. `unload`
dropped the cached read from 71,552 to 21,248, exactly the predicted removal
cost. The loaded tool dispatched normally (a tool-level `target_unavailable`,
not `UNKNOWN_TOOL`).

## Install

This is a DSH profile bundle. Install it through the official `plugin_manager`
tool (or the Plugin Manager page), not by editing the profile by hand:

```jsonc
plugin_manager { "action": "install_bundle", "target": "C:\\DSHprojects\\dsh-mcp-lazy" }
```

The bundle patch inserts one row:

```yaml
- insert:
    - id: mcp-lazy
      name: dsh-mcp-lazy
      config:
        servers:
          rea: 逆向工程与二进制分析
```

`config` is optional; see below. After installation the plugin activates through
HMR. Start a fresh session for the cleanest first request.

## Usage

The model sees the catalog and calls:

```jsonc
mcp({ "action": "list" })                       // servers, summaries, state
mcp({ "action": "load", "server": "rea" })      // enable all rea tools
mcp({ "action": "unload", "server": "rea" })    // hide them again
```

`load` takes effect on the **next** request: the current step's tool list is
already frozen. The tool result says so explicitly. If the model calls a hidden
tool anyway, the guard answers with the exact `load` call to make.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Turn the plugin off without uninstalling. |
| `toolName` | `mcp` | Meta tool name; falls back to `mcp_tools` on a collision. |
| `servers` | `{}` | `serverName` → one-line catalog summary (string or `{ summary }`). |
| `autoSummary` | `true` | When no `servers` summary exists, take the first sentence of the MCP server's own instructions. |
| `minTools` | `1` | Hide servers with at least this many tools; raise it to keep small servers resident. |
| `alwaysLoaded` | `[]` | Group names that are never hidden (including `other`). |
| `scope` | `mcp` | `mcp` = only `mcp__*` tools; `all` = every global tool outside `core` (registry-wide). |
| `core` | built-in list | For `scope: "all"`, exact tool names that stay directly callable. |
| `otherGroup` | `other` | Group name for non-MCP tools in registry-wide mode. |
| `catalogPlacement` | `context` | `context` (runtime context, survives complete personas) or `section` (system prompt). |
| `index` | `names` | Index returned by `load`: `names`, `summary`, or `none`. |
| `descriptionChars` | `40` | Summary/purpose truncation. |
| `maxIndexChars` | `4000` | Bound on the `load` tool index. |
| `healthGraceMs` | `15000` | How long a configured-but-empty server shows **Connecting** before it is marked **Unavailable**. |
| `healthProbe` | `true` | Actively probe Streamable HTTP servers for reachability. |
| `healthProbeTimeoutMs` | `3000` | Per-probe timeout. |
| `healthProbeCacheMs` | `5000` | Reuse a probe result for this long. |
| `healthMonitorMs` | `30000` | Background health pass period; `0` disables, minimum 5000. |
| `failureTtlMs` | `300000` | How long a failed tool call counts as evidence of an unreachable server. |
| `expectedTouchMs` | `300000` | Minimum spacing of `lastSeen` writes, so panel polling does not rewrite the file. |
| `stateFile` | `""` | MCP panel switch state path; the bundle sets `~/.dsh/mcp-lazy-state.json`. |
| `expectedFile` | `"~/.dsh/mcp-lazy-expected.json"` | Continuously maintained registry mirror (name/summary/transport/first+last seen); behind the **Missing** badge and **Forget**. `""` disables it. |
| `restoreOnResume` | `true` | Restore loaded servers from tool-addition history. |
| `allowUnload` | `true` | Expose `unload`. |

A patch replaces a row's whole `config`, so restate every key you set. The
package intentionally ships no Schemastery schema (it stays dependency-free), so
the Settings page shows no generated form; `resolveConfig` validates and clamps
every field at activation.

## Limitations

- Works on **globally registered** tools (the default `dsh-mcp-client` and
  plugin placement). Tools registered in an agent's own scope are always
  visible.
- In `scope: "mcp"`, public names are grouped by `mcp__<server>__`; a server
  whose name contains `__` should be listed in `servers` so routing is
  unambiguous.
- In `scope: "all"`, `other` is a single bucket; curate `core` and raise
  `minTools` if the agent needs more tools immediately.
- A newly discovered server without a `servers` entry is described as `N tools`;
  add a summary for better discoverability.
- Loaded state is per live agent, restored on resume from tool-addition history;
  compaction may require a fresh `load`.
- The catalog is deliberately state-free. Do not add "loaded" markers to it, or
  every `load`/`unload` would rewrite the stable prompt prefix and cost a cache
  miss.

## Maintenance (five-minute repair)

The panel is served by the Host. Ask the Host directly — that JSON is the truth,
the page only renders it:

```sh
curl -s "http://127.0.0.1:<gui-port>/mcp-lazy/servers"
# PowerShell: Invoke-RestMethod "http://127.0.0.1:<gui-port>/mcp-lazy/servers"
```

`<gui-port>` is the port in the DSH Web GUI URL. The payload has three parts:

- `servers[]` — one `status` per server (`active`, `connecting`, `down`,
  `always-visible`, `unconfigured`, `unknown`, `removed`), plus `health`, `reason`,
  `toolCount`, `mechanism`, and `abnormal`. **Read `status` first**: it is the only
  verdict. `reason` merely explains a `down` / `removed` / `unconfigured` row
  (`call-failed`, `unreachable`, `no-tools`, `unavailable`, `not-configured`,
  `configured-missing`, `scan-failed`).
- `scan` — `{ ok, error }`. `ok: false` means the plugin could not read the MCP
  configuration at all, so no "removed" verdict is trustworthy and the rows are
  reported as `unknown`.
- `counts` and `monitorMs` — per-status counts, and the current health period
  (`0` = off).

| Symptom | What to check | Repair |
|---|---|---|
| No `mcp` tool, no MCP line in the prompt | `plugin_manager list_plugins` → `include:mcp-lazy` must be `enabled: true`, `fiberPhase: active` | re-enable that row; if the row itself is gone, the bundle was dropped from `dsh.profile.bundles` |
| Red banner **Could not read the MCP configuration**, rows are **Config unreadable** | `scan.ok === false`, and `scan.error` names the cause | the loader's entry shape changed (DSH upgrade) or the plugin context is gone: reload `include:mcp-lazy`; if it persists, follow `scan.error` to the field it could not read |
| A server listed as **Missing** | no `@deepseek-ai/dsh-mcp-client` row claims it **and** `scan.ok === true` (otherwise it is `unknown`) | add the row back; name, transport and last summary are in `expectedFile`; if it is truly gone, use **Forget** (or `POST /mcp-lazy/forget`) |
| A server listed as **Not supervised** | tools are registered but no configuration row claims them | normal for preset / embedded hosts; if you did configure it, its row never reached the loader |
| A server **Unavailable** | configured but zero tools registered — `reason: call-failed` (last call could not connect), `unreachable` (probe failed twice), `no-tools` (endpoint answers but registered nothing), or `unavailable` | remote: token, URL, network; stdio: command path and args; Host log lines prefixed `[mcp-lazy]` and `[mcp]` |
| Tools stay hidden after `load` | the per-server switch disabled it | `stateFile` (`~/.dsh/mcp-lazy-state.json`) — remove the name, or delete the file |
| `index.js` / `client.js` edited, nothing changes | plugin code is read at mount; HMR does not watch this package | `plugin_manager set_plugin` → `include:mcp-lazy` `enabled: false`, then `true` |
| A `/mcp-lazy/*` route returns 404 | headless profile, or wrong port | those routes exist only where `webServer` is composed |
| A `/mcp-lazy/*` route returns 500 | old code is running (process started before the source edit), or the data contains a row that old code cannot handle | reload `include:mcp-lazy`; if it persists, read `settings route failed: <stack>` in the Host log |

Both files self-heal — missing or malformed reads as empty, never as an error:
`stateFile` holds the disabled switches, `expectedFile` is the continuously
written registry mirror behind the **Missing** badge; **Forget** removes one
tombstone without touching the rest.

Rollback: `dsh-mcp-lazy-0.1.0.tgz` beside this file is a packed copy from pack
time — check its date before relying on it; otherwise restore your own copy, then
reload the plugin row.

## Compatibility

Written and tested against DSH `0.2.1-rc.2` (desktop profile, `deepseek-flash`,
`toolUpdate: addition-only`). DSH is pre-1.0; the plugin uses public seams and
fails open if they move. No DSH installation file is modified; only the profile
manifest/lockfile records the bundle through `plugin_manager`.

## License

MIT. See [LICENSE](./LICENSE).
