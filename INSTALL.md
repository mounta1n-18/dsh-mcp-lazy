# Install `dsh-mcp-lazy` (agent instructions)

A DSH profile bundle. Do **not** edit the profile's `package.json` or
`cordis.patch.yml` by hand, and do **not** run pnpm in the profile directory.
`plugin_manager` performs installation.

## 1. Install

```jsonc
plugin_manager {
  "action": "install_bundle",
  "target": "C:\\DSHprojects\\dsh-mcp-lazy"
}
```

Read the returned `application` and `warnings`. `application: applied` means the
Host row is live; a `restart-required` result needs a DSH restart before the new
JavaScript generation is loaded.

Expected profile effect:

- `profiles/<profile>/package.json` gains a `dsh-mcp-lazy` dependency.
- `profiles/<profile>/cordis.patch.yml` gains a row with `id: mcp-lazy`.
- The bundle patch's `config.servers` is the initial one-line catalog.

## 2. Verify

Before installing, record the tool surface:

```jsonc
cordis_inspect_query { "platform": "host", "provider": "Tool", "method": "listTools" }
```

On the reference machine that is 253 tools, 207 of them `mcp__rea__*`,
238,322 bytes of JSON.

After installation, on the **next** step:

- `listTools` returns roughly 46 tools + `mcp`; no `mcp__rea__*`.
- The system prompt contains a section like `## MCP servers (lazy)` whose header
  states the load rule.
- Calling `mcp({ "action": "list" })` lists `rea` as `hidden` and reports the
  estimated schema tokens kept out of context (for example `≈47.1k tokens hidden`).
- Calling `mcp({ "action": "load", "server": "rea" })` returns a tool index and
  states that schemas arrive next step.
- The following `listTools` includes all 207 `mcp__rea__*` again.
- Self-healing: after `unload`, call any `mcp__rea__*` by name. The result must be
  a denial that names the exact `mcp({action:"load",server:"rea"})` call, not a
  bare `UNKNOWN_TOOL`.

Start a fresh session for the clean first-request measurement. Do not install in
the middle of a long session if you care about that request's prompt-cache hit:
hiding tools is a removal for the header diff and may miss once.

### Settings → MCP (Web)

The bundle also ships a Client half. After this first `dsh.client` declaration:

1. **Restart DSH.** The client module graph is composed at Host boot; a newly
   added `dsh.client` declaration is not hot-added by a plugin toggle.
2. Refresh the Web page. Settings should show an **MCP** entry.
3. The page lists `mcd` and `rea` with the emphasized name, the exact catalog
   summary, and a per-server switch; tool count/tokens are secondary. A healthy,
   lazily disclosed server has **no badge**. A red **Unavailable** badge means
   the configured server registered no tools; an amber **Disclosure inactive**
   badge means it bypasses the lazy mechanism; **Connecting** is the neutral
   first `healthGraceMs`. Configured servers with no tools are listed too, so a
   failed server is visible instead of silently missing. The switch controls
   agent disclosure only; MCP rows never appear in the plugin panel.

Check the data route without the UI:

```powershell
Invoke-WebRequest -Uri "$($env:DSH_WEB_URL)/mcp-lazy/servers" -UseBasicParsing
```

(Use the actual GUI origin, for example `http://127.0.0.1:56238`.) The route is
loopback-only. If the page does not appear after a restart, check that the
package manifest still has `dsh.client` and `exports["./client"]`, and that
`client.js` exists in the installed package.

## 3. Configure

### MCP servers are profile rows, not plugins

Do **not** install an MCP server as its own bundle. A bundle appears in the
plugin panel and gives you a plugin-level switch, which is the wrong boundary.
Add a `dsh-mcp-lazy/async` row to the profile patch instead; the MCP panel lists
it and owns its per-server switch. The lazy plugin is the only plugin-level
package.

`dsh-mcp-lazy/async` is the recommended name: it activates the official
`@deepseek-ai/dsh-mcp-client` on a detached fiber, so a slow or unreachable
server cannot delay startup (see README). A plain `@deepseek-ai/dsh-mcp-client`
row still works, but the host then waits for the first connection before the
desktop window appears.

Example MCD row in `~/.dsh/cordis.patch.yml` (the token stays in
`~/.dsh/.mcd-mcp-token`, never in the patch):

```yaml
- insert:
    - id: mcd-remote
      name: "dsh-mcp-lazy/async"
      config:
        serverName: mcd
        transport: streamable-http
        url: https://mcp.mcd.cn
        failOnStartupError: false
        headers:
          Authorization: !!js >-
            `Bearer ${process.getBuiltinModule('node:fs').readFileSync(process.getBuiltinModule('node:os').homedir() + '/.dsh/.mcd-mcp-token', 'utf8').trim()}`
```

The MCP panel switch controls **agent disclosure**, not the connection: off
hides the catalog line and all tools, on restores the summary-only catalog line.
State lives in `stateFile` (the bundle sets `~/.dsh/mcp-lazy-state.json`).

Edit the installed row's `config` (or the bundle's `cordis.patch.yml` before
installing). A patch replaces the whole `config`, so restate every key:

```yaml
- id: mcp-lazy
  name: dsh-mcp-lazy
  config:
    toolName: mcp
    scope: mcp            # mcp | all
    minTools: 1
    servers:
      rea: 逆向工程与二进制分析
    autoSummary: true
    alwaysLoaded: []
    catalogPlacement: context
    index: names
    healthGraceMs: 15000
    healthProbe: true
    stateFile: "~/.dsh/mcp-lazy-state.json"
    restoreOnResume: true
    allowUnload: true
```

`catalogPlacement: context` (the default) survives a `complete` persona section;
`section` puts the catalog in the system prompt instead. `scope: "all"` is the
registry-wide mode: every global tool outside `core` is deferred, MCP tools keep
their server groups, everything else goes to `other`. Keep `core` curated and
leave `scope: "mcp"` unless you want that authority over non-MCP tools.

Summary source: `servers.<name>` wins; otherwise `autoSummary: true` takes the
first sentence of the server's own `mcp:<name>` instructions; the last fallback
is `N tools`. A new server therefore gets a usable catalog line without an LLM
call or a script.

Health source: configured MCP rows (`dsh-mcp-lazy/async` or
`@deepseek-ai/dsh-mcp-client`) are read from the Loader, so a server with no
tools still has a row. `health` is `ok` when tools
are registered; after `healthGraceMs` without tools it becomes `unavailable` and
the page shows **Unavailable**. To exercise it, point a temporary MCP row at an
unreachable URL (`failOnStartupError: false`), wait past the grace, then remove
the row. Streamable HTTP servers also get a side-effect-free HEAD reachability
probe (any non-5xx answer counts as reachable, so WAF/session 4xx stays green);
stdio disconnects surface as **Connection error** on the next failed tool call
because the bridge keeps stale tool definitions.

## 4. No DSH-body edits

The plugin is one profile bundle linked from its own directory. `plugin_manager`
records it in the profile's `package.json` and lockfile; no file under the DSH
installation is modified. A DSH update replaces `app.asar`, not the bundle. The
catalog is registered at runtime and is not stored in a DSH file. If the plugin
is disabled or fails to load, all tools are visible (fail-open); the
`system-prompt/assemble` self-check logs and fails open if the catalog is ever
dropped while tools are hidden.

## 5. Loading a changed linked bundle

The Host caches a linked bundle's JavaScript. After editing `index.js` or
`lib/*.js`, load the new generation by toggling the row off and on in one step:

```jsonc
plugin_manager { "action": "set_plugin", "target": "include:mcp-lazy", "enabled": false }
plugin_manager { "action": "set_plugin", "target": "include:mcp-lazy", "enabled": true }
```

or restart DSH. Toggling disposes and re-creates the plugin; the two calls should
be sent together so no model request sees the intermediate state. A
`restart-required` application result means the toggle did not load fresh code.

## 6. Troubleshooting

| Symptom | Cause / action |
| --- | --- |
| No `mcp` tool after install | Read the install result; HMR may need a restart, or another plugin owns `mcp` (the plugin falls back to `mcp_tools`). |
| Catalog is empty | No `mcp__*` tools are registered right now. Check `listTools`; `dsh-mcp-client` may still be connecting. |
| `restrict failed ... unknown global tool` | The registry changed between schema read and restriction. The plugin logs and leaves tools visible; it retries on the next `tools/change`. |
| Model calls `mcp__rea__*` before load | It gets `UNKNOWN_TOOL`. Tell it to call `mcp` with `action: "load"` first; the catalog line is always present. |
| Loaded tools do not appear | Loading takes effect on the next request, not the current step. |
| `unload` seems to confuse the model | `addition-only` routes omit removal messages; the model may remember a tool that is no longer callable. Prefer leaving servers loaded once used. |

## 7. Uninstall / rollback

```jsonc
plugin_manager { "action": "remove_bundle", "target": "dsh-mcp-lazy" }
```

Then confirm the `mcp-lazy` row is gone from the profile patch and that
`listTools` shows every MCP tool again. The plugin's restrictions are owned by
agent scopes and its own effect: disabling the row restores all tools
immediately.

## 8. Where the source lives

`C:\DSHprojects\dsh-mcp-lazy` — keep it out of the workspace; it is the linked
package the profile refers to. Delete only after removing the bundle.
