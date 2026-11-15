/**
 * dsh-mcp-lazy — progressive disclosure for MCP servers on DeepSeek Harness.
 *
 * The bridge plugin (`@deepseek-ai/dsh-mcp-client`) registers every MCP tool as
 * a full model-facing ToolDefinition at connect time. This plugin keeps that
 * resolution surface small: each configured MCP server contributes one line to
 * the prompt catalog and one meta tool (`mcp`) carries list/load/unload. A
 * server's real tools are hidden per agent with the documented
 * `ctx.tools.restrict({ deny })` Service; `load` lifts exactly that server's
 * deny set, so the real tools re-enter the request through DSH's native
 * tool-addition path (`tool_addition` + deferred declaration), which keeps the
 * preceding conversation prefix cacheable.
 *
 * Deliberately no private APIs, no `system-prompt/assemble` rewrite, no MCP
 * transport reimplementation, and no dispatcher: loaded tools are called
 * natively with normal validation, approvals, guards, and scheduling.
 *
 * @module dsh-mcp-lazy
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'

import {
  assessHealth,
  buildIndex,
  buildInventory,
  computeDenyNames,
  groupOf,
  isAction,
  isConnectionFailure,
  isManagedToolName,
  renderCatalog,
  renderList,
  renderLoad,
  resolveConfig,
  serverOf,
  summarizeInstructions,
} from './lib/router.js'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'mcp-lazy'

/** Public Host services this plugin depends on. */
export const inject = ['agents', 'tools', 'systemPrompt']

const RESULT_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
}

/**
 * Register the lazy MCP surface for this Host.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {unknown} rawConfig - the Loader row's config object.
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) return

  const logger = ctx.logger
  const warn = (message) => {
    try {
      logger?.warn?.(`[mcp-lazy] ${message}`)
    } catch {
      // Logging must never break the plugin.
    }
  }
  const debug = (message) => {
    try {
      logger?.debug?.(`[mcp-lazy] ${message}`)
    } catch {
      // A missing debug channel is not an error.
    }
  }

  // Per-server switches live in the MCP panel, not the plugin list. Persist only
  // the disabled names; every server defaults to enabled.
  const stateFile = config.stateFile === ''
    ? ''
    : config.stateFile.replace(/^~(?=$|[\\/])/, homedir())
  const disabledServers = new Set()
  const loadState = () => {
    if (stateFile === '') return
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8'))
      if (Array.isArray(parsed?.disabled)) {
        for (const name of parsed.disabled) {
          if (typeof name === 'string' && name.length > 0) disabledServers.add(name)
        }
      }
    } catch {
      // Missing or malformed state means every server is enabled.
    }
  }
  const saveState = () => {
    if (stateFile === '') return
    try {
      mkdirSync(dirname(stateFile), { recursive: true })
      writeFileSync(stateFile, `${JSON.stringify({ disabled: [...disabledServers].sort() }, null, 2)}\n`)
    } catch (error) {
      warn(`could not save MCP panel state: ${String(error)}`)
    }
  }
  loadState()

  // Expected-server memory: a registry mirror, not a cache. Every MCP server
  // this Host has ever seen is remembered with its first and last sighting, so a
  // row that disappears (an editor rewriting the whole patch file is the usual
  // cause) still shows up in the panel as "missing" instead of silently
  // vanishing. Recording is continuous — start-up, every registry change, and
  // every health pass — and the file is rewritten only when a field actually
  // changed, with `lastSeen` refreshed on its own slow cadence so a 5-second
  // panel poll can never turn into a 5-second disk write.
  const expectedFile = config.expectedFile === ''
    ? ''
    : config.expectedFile.replace(/^~(?=$|[\\/])/, homedir())
  const readExpected = () => {
    const map = new Map()
    if (expectedFile === '') return map
    try {
      const parsed = JSON.parse(readFileSync(expectedFile, 'utf8'))
      for (const [name, value] of Object.entries(parsed?.servers ?? {})) {
        if (typeof name !== 'string' || name.length === 0) continue
        map.set(name, {
          summary: typeof value?.summary === 'string' ? value.summary : '',
          transport: typeof value?.transport === 'string' ? value.transport : '',
          firstSeen: typeof value?.firstSeen === 'string' ? value.firstSeen : '',
          lastSeen: typeof value?.lastSeen === 'string' ? value.lastSeen : '',
        })
      }
    } catch {
      // Missing or malformed memory just means nothing is expected yet.
    }
    return map
  }
  const expected = readExpected()
  let expectedTouchedAt = 0
  const saveExpected = () => {
    if (expectedFile === '') return
    try {
      mkdirSync(dirname(expectedFile), { recursive: true })
      const servers = Object.fromEntries([...expected.entries()].sort(([a], [b]) => a.localeCompare(b)))
      writeFileSync(expectedFile, `${JSON.stringify({ servers }, null, 2)}\n`)
    } catch (error) {
      warn(`could not save expected MCP servers: ${String(error)}`)
    }
  }

  // Fail open: an API that moved must leave every tool visible, never break a
  // session with a half-applied restriction.
  if (ctx.tools === undefined || typeof ctx.tools.schemas !== 'function' || typeof ctx.tools.register !== 'function' || typeof ctx.tools.restrict !== 'function') {
    warn('tools.schemas/register/restrict unavailable; staying inert (all MCP tools remain visible)')
    return
  }
  if (ctx.agents === undefined || typeof ctx.agents.list !== 'function') {
    warn('agents.list unavailable; staying inert (all MCP tools remain visible)')
    return
  }
  if (ctx.systemPrompt === undefined || (typeof ctx.systemPrompt.section !== 'function' && typeof ctx.systemPrompt.context !== 'function')) {
    warn('systemPrompt.section/context unavailable; staying inert')
    return
  }

  let index = { servers: new Map(), names: [] }
  /** Server names whose catalog summary came from the server's own instructions. */
  const derivedSummaries = new Map()
  /** @type {Map<string, { agent: object, revealed: Set<string>, hiddenNames: Set<string>, denyKey: string | undefined, dispose: (() => void) | undefined }>} */
  const states = new Map()
  let refreshing = false

  const applyDerivedSummaries = () => {
    if (!config.autoSummary) return
    for (const [name, summary] of derivedSummaries) {
      const entry = index.servers.get(name)
      if (entry !== undefined && entry.summary === '') entry.summary = summary
    }
  }

  const refreshIndex = () => {
    let schemas = []
    try {
      schemas = ctx.tools.schemas()
    } catch (error) {
      warn(`tools.schemas failed: ${String(error)}`)
    }
    index = buildIndex(schemas, config)
    applyDerivedSummaries()
  }

  /**
   * Publish one deny list to an agent's tool layer.
   *
   * Disposal happens before the new key is published so the synchronous
   * `tools/change` emitted by dispose/restrict cannot recurse into `sync`.
   *
   * @param {object} state - per-agent state.
   * @param {string[]} deny - tool names to hide.
   * @returns {boolean} whether the restriction is in place (or unnecessary).
   */
  const applyDeny = (state, deny) => {
    state.denyKey = deny.join('\n')
    state.hiddenNames = new Set(deny)
    try {
      state.dispose?.()
    } catch (error) {
      warn(`previous restriction disposal failed: ${String(error)}`)
    }
    state.dispose = undefined
    if (deny.length === 0) return true

    try {
      state.dispose = state.agent.ctx.tools.restrict({ deny })
      return true
    } catch (error) {
      state.denyKey = undefined
      state.hiddenNames = new Set()
      debug(`restrict failed (${String(error)}); the index may be stale`)
      return false
    }
  }

  const sync = (state) => {
    let deny
    try {
      deny = computeDenyNames(index, state.revealed, config, disabledServers)
    } catch (error) {
      warn(`deny computation failed: ${String(error)}`)
      return
    }
    const key = deny.join('\n')
    if (state.denyKey === key) return
    if (applyDeny(state, deny)) return

    // One retry with a freshly rebuilt index. `restrict` rejects names it does
    // not know, and a server that (dis)connected between our last refresh and
    // this call leaves exactly that kind of stale name behind. Retrying once is
    // enough: the second index is read immediately before the second call.
    refreshIndex()
    try {
      deny = computeDenyNames(index, state.revealed, config, disabledServers)
    } catch {
      return
    }
    if (!applyDeny(state, deny)) {
      warn(`restrict failed for agent ${String(state.agent.id)}; leaving tools visible (fail-open)`)
    }
  }

  const refresh = () => {
    if (refreshing) return
    refreshing = true
    try {
      refreshIndex()
      for (const state of states.values()) sync(state)
    } finally {
      refreshing = false
    }
  }

  // ---------------------------------------------------------------------------
  // Server registry: discovery, continuous registration, and transport health.
  //
  // `dsh-mcp-client` publishes no service and emits no events, so everything
  // below is inferred from three pieces of evidence the Host does expose: the
  // loader rows (which servers are supposed to exist), the tool registry (which
  // ones actually connected), and tool results (whether a call just failed).

  /** Cordis loader row that owns one MCP server. */
  const MCP_CLIENT_PLUGIN = '@deepseek-ai/dsh-mcp-client'

  /**
   * Why the last loader scan produced no rows, or `null` when it succeeded.
   *
   * Without this, "the user has no MCP rows" and "the loader could not be read"
   * both look like an empty Map, and the panel reports every remembered server
   * as missing — a diagnosis that blames the user's configuration for a plugin
   * that simply could not see it.
   */
  let scanFailure = null

  /**
   * Configured MCP servers, read from the Cordis loader.
   *
   * This is the only place a server's transport metadata (url, command) is
   * observable, so it is the source of truth for "should this exist" — a server
   * listed here but absent from the tool registry is the "配置了却没连上" case.
   *
   * @returns {Map<string, { name: string, transport: string, url: string, description: string }>} rows by server name.
   */
  const scanConfiguredServers = () => {
    const rows = new Map()
    let entries = []
    try {
      entries = [...(ctx.loader?.entries?.() ?? [])]
      scanFailure = null
    } catch (error) {
      scanFailure = String(error)
      debug(`loader entries unavailable: ${String(error)}`)
      return rows
    }
    for (const entry of entries) {
      // One unreadable row must not take the whole scan down: that would turn
      // "this loader is not what we expect" into an exception thrown out of
      // the settings route, which is exactly the failure mode this scan was
      // made to report instead of crash on.
      try {
        const options = entry?.options
        if (options?.name !== MCP_CLIENT_PLUGIN) continue
        const row = options.config
        const name = typeof row?.serverName === 'string' ? row.serverName : ''
        if (name.length === 0) continue
        rows.set(name, {
          name,
          transport: typeof row.transport === 'string' ? row.transport : '',
          url: typeof row.url === 'string' ? row.url : '',
          description: typeof row.description === 'string' ? row.description : '',
        })
      } catch (error) {
        scanFailure ??= String(error)
        debug(`loader entry unreadable: ${String(error)}`)
      }
    }
    return rows
  }

  /**
   * Merge every server this Host can currently see into the expected-server
   * memory. Called at start-up, on every registry change, and on every health
   * pass — never only from the panel. Entries are never pruned here: a row that
   * stopped existing must stay visible as "missing" until the user forgets it.
   *
   * @param {{ touch?: boolean }} [options] - `touch` refreshes `lastSeen` (throttled by `expectedTouchMs`).
   * @returns {Map<string, { name: string, transport: string, url: string, description: string }>} configured rows.
   */
  const recordExpected = ({ touch = false } = {}) => {
    const configured = scanConfiguredServers()
    const stamp = new Date().toISOString()
    const touchDue = touch && Date.now() - expectedTouchedAt >= config.expectedTouchMs
    let changed = false
    const upsert = (name, summary, transport) => {
      if (typeof name !== 'string' || name.length === 0) return
      const current = expected.get(name)
      if (current === undefined) {
        expected.set(name, { summary: summary ?? '', transport: transport ?? '', firstSeen: stamp, lastSeen: stamp })
        changed = true
        return
      }
      if (current.summary === '' && summary) {
        current.summary = summary
        changed = true
      }
      if (current.transport === '' && transport) {
        current.transport = transport
        changed = true
      }
      if (touchDue && current.lastSeen !== stamp) {
        current.lastSeen = stamp
        changed = true
      }
    }
    for (const row of configured.values()) upsert(row.name, row.description, row.transport)
    for (const entry of index.servers.values()) upsert(entry.name, entry.summary, '')
    if (touch) expectedTouchedAt = Date.now()
    if (changed) saveExpected()
    return configured
  }

  /**
   * Drop one remembered server from the expected memory. Only a tombstone — a
   * name that neither the loader nor the registry knows — may be forgotten, so
   * this can never hide a live server from the panel.
   *
   * @param {string} name - server name.
   * @returns {boolean} whether anything was removed.
   */
  const forgetExpected = (name) => {
    if (typeof name !== 'string' || name.length === 0) return false
    if (scanConfiguredServers().has(name) || index.servers.has(name)) return false
    if (!expected.delete(name)) return false
    saveExpected()
    health.delete(name)
    probes.delete(name)
    toolFailures.delete(name)
    firstObserved.delete(name)
    return true
  }

  /** First time this Host process saw a server, used for the start-up grace window. */
  const firstObserved = new Map()
  /** Latest verdict per server: `{ health, reason, checkedAt, probeStatus }`. */
  const health = new Map()
  /** Last HTTP probe per server: `{ at, ok, status }`. */
  const probes = new Map()
  /** In-flight probes, so a burst of requests cannot multiply fetches. */
  const pendingProbes = new Map()
  /** Last connection-shaped tool failure per server: `{ at, kind }`. */
  const toolFailures = new Map()

  /**
   * Every server name this Host has a reason to care about, for name parsing and
   * history restore.
   * @returns {Set<string>} configured ∪ registered names.
   */
  const knownServers = () => new Set([...Object.keys(config.servers), ...index.servers.keys()])

  /**
   * Age of the most recent connection-shaped tool failure, or Infinity.
   *
   * A failure is evidence only until its TTL expires; a successful call clears
   * it immediately, because the failure says "that call failed", not "this
   * server is broken".
   *
   * @param {string} name - server name.
   * @returns {number} milliseconds since the failure, or Infinity.
   */
  const failureAge = (name) => {
    const failure = toolFailures.get(name)
    if (failure === undefined) return Number.POSITIVE_INFINITY
    const age = Date.now() - failure.at
    if (age > config.failureTtlMs) {
      toolFailures.delete(name)
      return Number.POSITIVE_INFINITY
    }
    return Math.max(age, 0)
  }

  /**
   * Probe a remote server's endpoint.
   *
   * Only an HTTP transport has something an unauthenticated HEAD can reach;
   * stdio is never probed (there is no port to knock on, and spawning a second
   * copy would be a side effect). A HEAD that answers below 500 means the
   * endpoint is up even when it rejects the method — 405/400/401 all prove a
   * live server, which is the only thing this probe claims.
   *
   * @param {{ name: string, transport: string, url: string } | undefined} row - configured row.
   * @returns {Promise<{ at: number, ok: boolean, status: number } | undefined>} probe result, or undefined when not applicable.
   */
  const probeHttp = async (row) => {
    if (!config.healthProbe || row === undefined || row.transport !== 'streamable-http' || row.url === '') return undefined
    const cached = probes.get(row.name)
    if (cached !== undefined && Date.now() - cached.at < config.healthProbeCacheMs) return cached
    const pending = pendingProbes.get(row.name)
    if (pending !== undefined) return pending
    const run = (async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), config.healthProbeTimeoutMs)
      timer.unref?.()
      // Consecutive failures, so a single flaky HEAD (proxy, DNS, a token that
      // expired and is about to refresh) does not flip a working server to down.
      const misses = (probes.get(row.name)?.failures ?? 0)
      try {
        const response = await fetch(row.url, { method: 'HEAD', signal: controller.signal })
        const result = { at: Date.now(), ok: response.status < 500, status: response.status, failures: 0 }
        probes.set(row.name, result)
        return result
      } catch {
        // DNS failure, refused connection, TLS error, timeout: all "unreachable".
        const result = { at: Date.now(), ok: false, status: 0, failures: misses + 1 }
        probes.set(row.name, result)
        return result
      } finally {
        clearTimeout(timer)
        pendingProbes.delete(row.name)
      }
    })()
    pendingProbes.set(row.name, run)
    return run
  }

  /**
   * Recompose one server's health verdict from the evidence on hand.
   * @param {string} name - server name.
   * @param {{ configured: boolean, probe?: { ok: boolean, status: number } }} evidence - inputs.
   * @returns {{ health: string, reason: string | undefined }} verdict.
   */
  const assessNow = (name, { configured, probe }) => {
    const entry = index.servers.get(name)
    const first = firstObserved.get(name)
    return assessHealth({
      toolCount: entry?.tools.length ?? 0,
      configured,
      ageMs: first === undefined ? 0 : Date.now() - first,
      graceMs: config.healthGraceMs,
      failureAgeMs: failureAge(name),
      failureTtlMs: config.failureTtlMs,
      probe,
    })
  }

  let probeRun = undefined
  /**
   * Probe every remote server once, deduplicated across concurrent callers.
   * @param {Map<string, object>} configured - rows to probe.
   * @returns {Promise<Map<string, object>>} the rows that were probed.
   */
  const probeAll = (configured) => {
    if (probeRun !== undefined) return probeRun
    probeRun = (async () => {
      await Promise.all([...configured.values()].map((row) => probeHttp(row)))
      return configured
    })().finally(() => {
      probeRun = undefined
    })
    return probeRun
  }

  /**
   * Fold the evidence on hand into one verdict per server.
   *
   * Synchronous on purpose: a tool result must be reflected immediately, not on
   * the next timer tick. Probe results come from the cache filled by `probeAll`.
   *
   * @param {Map<string, object>} [configured] - configured rows; re-read when omitted.
   */
  const recomputeHealth = (configured = scanConfiguredServers()) => {
    const names = new Set([...configured.keys(), ...index.servers.keys()])
    for (const name of names) {
      if (!firstObserved.has(name)) firstObserved.set(name, Date.now())
      const probe = probes.get(name)
      const verdict = assessNow(name, { configured: configured.has(name), probe })
      const previous = health.get(name)
      if (previous === undefined || previous.health !== verdict.health || previous.reason !== verdict.reason) {
        if (verdict.health === 'ok') debug(`MCP server ${name}: ok`)
        else warn(`MCP server ${name}: ${verdict.health}${verdict.reason === undefined ? '' : ` (${verdict.reason})`}`)
      }
      health.set(name, { ...verdict, checkedAt: Date.now(), probeStatus: probe?.status ?? null })
    }
    for (const name of [...health.keys()]) if (!names.has(name)) health.delete(name)
  }

  /**
   * Re-read the registry, probe remote servers, and store verdicts. Runs at
   * start-up and on a timer, independent of whether anyone has the panel open.
   *
   * @returns {Promise<void>} resolves when every verdict is stored.
   */
  const refreshHealth = async () => {
    const configured = scanConfiguredServers()
    await probeAll(configured)
    recomputeHealth(configured)
    recordExpected({ touch: true })
  }

  if (config.healthMonitorMs > 0) {
    ctx.effect(() => {
      const timer = setInterval(() => { void refreshHealth() }, config.healthMonitorMs)
      timer.unref?.()
      return () => clearInterval(timer)
    })
  }

  /**
   * Switch one server's disclosure from the MCP panel. Disabling hides every
   * tool and clears the server from each agent's loaded set; enabling restores
   * the summary-only catalog line (tools stay lazy until `load`).
   * @param {string} server - server name.
   * @param {boolean} enabled - desired state.
   */
  const setServerEnabled = (server, enabled) => {
    if (enabled) {
      disabledServers.delete(server)
    } else {
      disabledServers.add(server)
    }
    // Turning a server on starts from the summary only, even when its tools
    // were in durable history while it was off. Turning it off hides them now.
    for (const state of states.values()) state.revealed.delete(server)
    saveState()
    for (const state of states.values()) sync(state)
  }

  /**
   * Restore servers an agent already loaded, from the durable tool-addition
   * history. Only additions count: an initial header that predates the plugin
   * must not silently reveal everything.
   *
   * The known-name set is configured ∪ registered, not just `config.servers`:
   * a server that was discovered from the registry (never listed in the patch
   * file) must still come back loaded after a resume, otherwise every restart
   * silently unloads it.
   *
   * @param {object} state - per-agent state.
   * @returns {number} how many servers this pass added.
   */
  const restoreFromHistory = (state) => {
    if (!config.restoreOnResume) return 0
    try {
      const history = state.agent.session?.toolHistory?.()
      if (history === undefined || history === null) return 0
      const names = [...knownServers()]
      let added = 0
      for (const update of history.updates ?? []) {
        for (const tool of update?.additions ?? []) {
          if (typeof tool?.name !== 'string') continue
          const server = serverOf(tool.name, names)
          if (server === undefined || state.revealed.has(server)) continue
          state.revealed.add(server)
          added += 1
        }
      }
      return added
    } catch (error) {
      debug(`tool history restore skipped: ${String(error)}`)
      return 0
    }
  }

  const ensureState = (agent) => {
    const existing = states.get(agent.id)
    if (existing !== undefined) return existing
    // `restoreAttempts` lets a later assembly retry when the registry was still
    // empty at agent creation (a slow stdio server, for instance).
    const state = { agent, revealed: new Set(), hiddenNames: new Set(), denyKey: undefined, dispose: undefined, restoreAttempts: 0, touched: false }
    states.set(agent.id, state)
    restoreFromHistory(state)
    state.restoreAttempts += 1
    sync(state)
    return state
  }

  refreshIndex()
  // Register what exists right now, and take the first health reading, before
  // any panel or prompt asks for it.
  recordExpected()
  void refreshHealth()

  const makeMetaTool = (toolName) => ({
    name: toolName,
    description: [
      `Deferred tools are loaded on demand: their full schemas are not in context until enabled (${config.scope === 'all' ? 'registry-wide mode: MCP servers and other deferred groups' : 'MCP servers'}).`,
      '"list" shows each group, its one-line purpose, tool count, and whether it is enabled for this agent;',
      '"load" enables one group so its tools and full schemas become available from the NEXT step;',
      '"unload" hides it again. Call load before using a hidden tool.',
      'The prompt catalog lists every group; use list if the catalog looks missing or stale.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'load', 'unload'],
          description: '"list" shows groups and state; "load" enables one group; "unload" hides it again.',
        },
        server: {
          type: 'string',
          description: 'Exact MCP server or deferred group name from the catalog. Required for load and unload.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: RESULT_SCHEMA,
      render(_args, value) {
        const text = value !== null && typeof value === 'object' && typeof value.text === 'string' ? value.text : ''
        return [{ type: 'text', text }]
      },
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error(`${toolName} requires an agent-scoped execution`)
      const state = ensureState(exec.agent)
      const action = args?.action
      if (!isAction(action)) throw new Error(`unknown action ${JSON.stringify(action)}; use list, load, or unload`)

      if (action === 'list') return { text: renderList(index, state.revealed, config, disabledServers, health) }

      const server = typeof args?.server === 'string' ? args.server.trim() : ''
      if (server.length === 0) {
        throw new Error(`"${action}" requires "server". Known groups: ${[...index.servers.keys()].filter((name) => !disabledServers.has(name)).join(', ') || '(none)'}`)
      }
      const entry = index.servers.get(server)
      if (entry === undefined) {
        throw new Error(`unknown deferred group ${JSON.stringify(server)}. Known groups: ${[...index.servers.keys()].filter((name) => !disabledServers.has(name)).join(', ') || '(none)'}`)
      }

      if (action === 'load') {
        if (disabledServers.has(server)) throw new Error(`MCP server ${JSON.stringify(server)} is disabled in the MCP panel; enable it there first.`)
        state.revealed.add(server)
        state.touched = true
        sync(state)
        return { text: renderLoad(entry, config, health.get(server)) }
      }

      if (config.allowUnload !== true) throw new Error('unload is disabled by configuration')
      state.revealed.delete(server)
      state.touched = true
      sync(state)
      return {
        text: `Hid "${server}". Its tools will be absent from the next request; this usually costs one prompt-cache miss.`,
      }
    },
  })

  let toolName = config.toolName
  let registered = false
  try {
    ctx.tools.register(makeMetaTool(toolName))
    registered = true
  } catch (error) {
    warn(`could not register ${JSON.stringify(toolName)}: ${String(error)}`)
    if (toolName !== 'mcp_tools') {
      toolName = 'mcp_tools'
      try {
        ctx.tools.register(makeMetaTool(toolName))
        registered = true
        warn('registered the meta tool as "mcp_tools" instead')
      } catch (fallbackError) {
        warn(`fallback registration failed: ${String(fallbackError)}`)
      }
    }
  }
  if (!registered) return

  // The effective name can differ from the configured one after a collision
  // fallback; the stable catalog must name the tool the model can actually call.
  config.toolName = toolName

  // Give the model a self-healing path when it calls a hidden tool by name
  // (stale history after unload, a typo, or a server added mid-conversation).
  // Without this guard the registry reports a bare UNKNOWN_TOOL with no hint.
  if (typeof ctx.tools.guard === 'function') {
    try {
      ctx.tools.guard((execution) => {
        const callName = execution.name
        if (!isManagedToolName(callName, config)) return undefined
        const agent = execution.agent
        if (agent === undefined) return undefined
        const state = states.get(agent.id)
        if (state === undefined) return undefined
        if (ctx.tools.get(callName, agent) !== undefined) return undefined

        if (state.hiddenNames.has(callName)) {
          const group = groupOf(callName, config)
          return `Deferred group ${JSON.stringify(group)} is not loaded: this tool is not in context yet. Call ${toolName}({action:"load",server:${JSON.stringify(group)}}) first; its tools become callable from the next step.`
        }
        if (config.scope !== 'mcp') return undefined

        const server = serverOf(callName, Object.keys(config.servers))
        const entry = server === undefined ? undefined : index.servers.get(server)
        if (entry === undefined) {
          const known = [...index.servers.keys()]
          return `Unknown MCP tool ${JSON.stringify(callName)}. Registered MCP servers: ${known.join(', ') || '(none)'}. Call ${toolName}({action:"list"}) to inspect them.`
        }
        if (!entry.tools.some((tool) => tool.name === callName)) {
          return `Unknown tool ${JSON.stringify(callName)} for MCP server ${JSON.stringify(server)}. Call ${toolName}({action:"list"}) to inspect the server.`
        }
        return undefined
      })
    } catch (error) {
      warn(`tools.guard registration failed; hidden calls will report UNKNOWN_TOOL: ${String(error)}`)
    }
  } else {
    warn('tools.guard unavailable; hidden calls will report UNKNOWN_TOOL')
  }

  const catalogText = () => renderCatalog(index, config, disabledServers)
  if (config.catalogPlacement === 'context' && typeof ctx.systemPrompt.context === 'function') {
    ctx.systemPrompt.context({
      name: 'mcp-lazy:catalog',
      order: 40,
      required: true,
      text: catalogText,
    })
  } else {
    let order = 500
    try {
      order = ctx.systemPrompt.getSectionOrder('MCP_SERVERS')
    } catch {
      // Keep the numeric fallback when the placement registry changes.
    }
    if (!Number.isFinite(order)) order = 500
    ctx.systemPrompt.section({
      name: 'mcp-lazy:catalog',
      order,
      text: catalogText,
    })
  }

  try {
    for (const agent of ctx.agents.list()) ensureState(agent)
  } catch (error) {
    warn(`could not enumerate live agents: ${String(error)}`)
  }
  ctx.on('agent/created', ({ agent }) => {
    try {
      ensureState(agent)
    } catch (error) {
      warn(`agent initialization failed: ${String(error)}`)
    }
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const state = states.get(agent.id)
    if (state === undefined) return
    states.delete(agent.id)
    try {
      state.dispose?.()
    } catch (error) {
      warn(`restriction disposal failed: ${String(error)}`)
    }
  })
  ctx.on('tools/change', () => {
    try {
      refresh()
    } catch (error) {
      warn(`index refresh failed: ${String(error)}`)
    }
  })

  // Pull-based safety net + catalog self-check. This does not rely on an
  // external watcher or script: every assembled request is an opportunity to
  // notice (a) a managed tool the index has not seen yet, and (b) a catalog
  // that a complete persona or a changed prompt API dropped while tools remain
  // hidden. Both are answered in-process. A missing catalog fails open instead
  // of leaving the model with hidden tools and no way to discover them.
  let selfCheckWarned = false
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const resolved = await next()
    try {
      if (config.autoSummary) {
        const sections = Array.isArray(resolved?.sections) ? resolved.sections : []
        for (const section of sections) {
          if (typeof section?.name !== 'string' || !section.name.startsWith('mcp:')) continue
          const server = section.name.slice(4)
          const entry = index.servers.get(server)
          if (entry === undefined || entry.summary !== '') continue
          const summary = summarizeInstructions(section.text, server)
          if (summary.length === 0 || derivedSummaries.get(server) === summary) continue
          derivedSummaries.set(server, summary)
          entry.summary = summary
        }
      }

      // Pull audit. `resolved.tools` does not exist at this point — the
      // waterfall returns `{ sections, contexts, variables }` and tools are
      // attached to the result after every listener has run — but
      // `context.toolSet` is the very set this step admits into the model's
      // view. A managed tool admitted there that our index has never seen means
      // a restriction was stale (a server connected mid-step), so rebuild.
      const admitted = context?.toolSet?.view?.(context?.scope)
      if (!refreshing && admitted !== undefined && [...admitted.keys()].some((name) => isManagedToolName(name, config) && !index.names.includes(name))) {
        queueMicrotask(() => {
          try {
            refresh()
          } catch (error) {
            warn(`pull refresh failed: ${String(error)}`)
          }
        })
      }

      // Late restore: an agent created before its MCP server finished starting
      // had an empty history to restore from. Retry while the registry fills in.
      if (config.restoreOnResume) {
        for (const state of states.values()) {
          if (state.touched || state.restoreAttempts >= 2) continue
          state.restoreAttempts += 1
          if (restoreFromHistory(state) > 0) sync(state)
        }
      }

      const hidden = [...states.values()].some((state) => state.hiddenNames.size > 0)
      if (!hidden) return resolved
      const present = config.catalogPlacement === 'context'
        ? Array.isArray(resolved?.contexts) && resolved.contexts.some((entry) => entry?.name === 'mcp-lazy:catalog')
        : Array.isArray(resolved?.sections) && resolved.sections.some((entry) => entry?.name === 'mcp-lazy:catalog')
      if (present || selfCheckWarned) return resolved
      selfCheckWarned = true
      warn('catalog is not visible in the assembled prompt; failing open so hidden tools are not left without a catalog (use catalogPlacement: context for presets with a complete persona)')
      queueMicrotask(() => {
        for (const state of states.values()) {
          state.denyKey = undefined
          state.hiddenNames = new Set()
          for (const entry of index.servers.values()) state.revealed.add(entry.name)
          try {
            state.dispose?.()
          } catch (error) {
            warn(`fail-open restriction disposal failed: ${String(error)}`)
          }
          state.dispose = undefined
        }
      })
    } catch (error) {
      debug(`assembly self-check skipped: ${String(error)}`)
    }
    return resolved
  }, { prepend: true })

  ctx.effect(() => () => {
    for (const state of states.values()) {
      try {
        state.dispose?.()
      } catch (error) {
        warn(`restriction disposal failed: ${String(error)}`)
      }
    }
    states.clear()
  }, 'mcp-lazy.restrictions')

  // Connection-shaped tool failures are the only failure evidence a stdio
  // server can produce, so they feed the same verdict as the HTTP probe. A
  // success clears the failure: "that call failed" is not "this server is
  // broken".
  ctx.on('tools/result', (exec, result) => {
    const name = exec?.name
    if (typeof name !== 'string' || !isManagedToolName(name, config)) return
    const server = serverOf(name, [...knownServers()])
    if (server === undefined) return
    if (result?.isError === true) {
      const text = JSON.stringify(result?.content ?? result?.error ?? '')
      if (!isConnectionFailure(text)) return
      const previous = health.get(server)
      toolFailures.set(server, { at: Date.now(), kind: 'connection' })
      recomputeHealth()
      if (previous?.reason !== 'call-failed') {
        warn(`a tool call could not reach MCP server ${server}; marking it unavailable until it answers again`)
      }
    } else {
      // A successful call is proof the server answers, which outranks any
      // cached probe (a HEAD never opens an MCP session).
      const clearedFailure = toolFailures.delete(server)
      const clearedProbe = probes.delete(server)
      if (clearedFailure || clearedProbe) recomputeHealth()
    }
  })

  // Browser settings page data. The Web server is optional so the Host stays
  // usable in headless profiles. Every route is loopback-only: the panel is a
  // local view of Host state, not a remote API.
  ctx.inject(['webServer'], (webCtx) => {
    /** @param {import('node:http').IncomingMessage} req */
    const isLoopback = (req) => {
      const address = req.socket?.remoteAddress ?? ''
      return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
    }

    const json = (res, status, value) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(value))
    }

    const plain = (res, status, text) => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(text)
    }

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/mcp-lazy/servers',
      handler: async (req, res) => {
        if (!isLoopback(req)) {
          plain(res, 403, 'forbidden')
          return
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { allow: 'GET, HEAD' })
          res.end('method not allowed')
          return
        }
        try {
          // The panel is a chance to re-register, not the only chance: start-up,
          // every registry change, and the health timer all record too.
          const configured = recordExpected({ touch: true })
          await refreshHealth()
          // Fold once more from the (possibly cached) probe results so a tool
          // result received while the probe was in flight is not overwritten.
          recomputeHealth(configured)
          // One row per server, one status each. The route serializes; it does
          // not decide what a row means — that lives in `buildInventory`, where
          // every state has a branch instead of a fall-through.
          const inventory = buildInventory({
            configured,
            index,
            expected,
            disabled: disabledServers,
            health,
            config,
            scan: { ok: scanFailure === null, error: scanFailure },
          })
          const body = JSON.stringify({
            generatedAt: new Date().toISOString(),
            toolName,
            scope: config.scope,
            enabled: config.enabled,
            expectedFile,
            monitorMs: config.healthMonitorMs,
            scan: inventory.scan,
            counts: inventory.counts,
            servers: inventory.servers,
          })
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(req.method === 'HEAD' ? undefined : body)
        } catch (error) {
          // Log the stack, not just the message: a one-line warn is what turned
          // an earlier bug into an invisible 500. The response stays generic.
          warn(`settings route failed: ${error?.stack ?? String(error)}`)
          plain(res, 500, 'mcp-lazy settings route failed')
        }
      },
    }), 'mcp-lazy: settings route')

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/mcp-lazy/toggle',
      handler: async (req, res) => {
        if (!isLoopback(req)) {
          plain(res, 403, 'forbidden')
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' })
          res.end('method not allowed')
          return
        }
        try {
          let body = ''
          for await (const chunk of req) {
            body += chunk
            if (body.length > 4096) {
              res.writeHead(413)
              res.end('payload too large')
              return
            }
          }
          const parsed = JSON.parse(body)
          const name = typeof parsed?.name === 'string' ? parsed.name.trim() : ''
          const enabled = parsed?.enabled
          if (name === '' || typeof enabled !== 'boolean') {
            plain(res, 400, 'expected { "name": string, "enabled": boolean }')
            return
          }
          if (!scanConfiguredServers().has(name) && !index.servers.has(name)) {
            plain(res, 404, 'unknown MCP server')
            return
          }
          setServerEnabled(name, enabled)
          json(res, 200, { ok: true, name, enabled })
        } catch (error) {
          warn(`toggle route failed: ${String(error)}`)
          plain(res, 400, 'invalid toggle request')
        }
      },
    }), 'mcp-lazy: toggle route')

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/mcp-lazy/forget',
      handler: async (req, res) => {
        if (!isLoopback(req)) {
          plain(res, 403, 'forbidden')
          return
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'POST' })
          res.end('method not allowed')
          return
        }
        try {
          let body = ''
          for await (const chunk of req) {
            body += chunk
            if (body.length > 4096) {
              res.writeHead(413)
              res.end('payload too large')
              return
            }
          }
          const parsed = JSON.parse(body)
          const name = typeof parsed?.name === 'string' ? parsed.name.trim() : ''
          if (name === '') {
            plain(res, 400, 'expected { "name": string }')
            return
          }
          if (!forgetExpected(name)) {
            plain(res, 409, 'refusing to forget a server that is still configured or still registered')
            return
          }
          json(res, 200, { ok: true, name })
        } catch (error) {
          warn(`forget route failed: ${String(error)}`)
          plain(res, 400, 'invalid forget request')
        }
      },
    }), 'mcp-lazy: forget route')
  })
}
