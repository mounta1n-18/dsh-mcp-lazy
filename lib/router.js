/**
 * Pure helpers for dsh-mcp-lazy: MCP public-name routing, catalog indexing,
 * per-agent deny computation, and model-facing text rendering.
 *
 * Nothing in this module touches a Cordis context, so it is directly testable
 * with `node --test`.
 */

/** @typedef {{ name: string, description: string }} CatalogTool */
/** @typedef {{ name: string, summary: string, tools: CatalogTool[] }} ServerEntry */
/** @typedef {{ servers: Map<string, ServerEntry>, names: string[] }} CatalogIndex */

const MCP_PREFIX = 'mcp__'
const ACTION_NAMES = new Set(['list', 'load', 'unload'])
const INDEX_STYLES = new Set(['names', 'summary', 'none'])
const SCOPES = new Set(['mcp', 'all'])

/**
 * Core tools that stay directly callable in registry-wide (`scope: "all"`)
 * mode. The meta tool itself is always excluded separately. The list is a
 * conservative working set for the shipped Harness; extend it in `config.core`
 * for your own always-on tools.
 */
export const DEFAULT_CORE = Object.freeze([
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'pwsh',
  'working_directory',
  'skill',
  'ask_user_question',
  'todo_write',
  'present',
  'web_search',
  'web_fetch',
  'list_agents',
  'send_message',
  'spawn_teammate',
  'wait_agent',
  'team_task_create',
  'team_task_list',
  'team_task_get',
  'team_task_update',
  'job_list',
  'job_output',
  'job_kill',
  'get_goal',
  'create_goal',
  'update_goal',
  'mcp',
])

/**
 * Resolve the MCP server that owns a public `mcp__<server>__<tool>` name.
 *
 * Configured server names win, longest first, so a server whose own name
 * contains `__` still routes to the configured identity. Otherwise the first
 * `__` segment is used (the common case for `dsh-mcp-client` namespaces).
 *
 * @param {string} toolName - model-facing public tool name.
 * @param {Iterable<string>} [knownServers] - configured server names.
 * @returns {string | undefined} server name, or undefined when not MCP.
 */
export function serverOf(toolName, knownServers = []) {
  if (typeof toolName !== 'string' || !toolName.startsWith(MCP_PREFIX)) return undefined
  const rest = toolName.slice(MCP_PREFIX.length)
  const configured = [...knownServers].filter((name) => typeof name === 'string' && name.length > 0)
  configured.sort((left, right) => right.length - left.length)
  for (const server of configured) {
    if (rest.startsWith(`${server}__`)) return server
  }
  const marker = rest.indexOf('__')
  if (marker <= 0) return undefined
  return rest.slice(0, marker)
}

/**
 * Normalize the plugin's raw row config into the shape the runtime uses.
 *
 * The plugin deliberately exports no Schemastery `Config`: a profile bundle is
 * plain ESM, and a manual resolver keeps the package dependency-free while
 * still failing soft on malformed values.
 *
 * @param {unknown} raw - the Loader row's `config` object.
 * @returns {object} resolved config.
 */
export function resolveConfig(raw = {}) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}

  const servers = {}
  if (input.servers !== null && typeof input.servers === 'object' && !Array.isArray(input.servers)) {
    for (const [server, value] of Object.entries(input.servers)) {
      if (typeof value === 'string') servers[server] = { summary: value }
      else if (value !== null && typeof value === 'object' && typeof value.summary === 'string') servers[server] = { summary: value.summary }
    }
  }

  const alwaysLoaded = Array.isArray(input.alwaysLoaded)
    ? input.alwaysLoaded.filter((name) => typeof name === 'string' && name.length > 0)
    : []

  const toolName = typeof input.toolName === 'string' && /^[A-Za-z0-9_-]{1,60}$/.test(input.toolName)
    ? input.toolName
    : 'mcp'

  const minTools = Number.isInteger(input.minTools) && input.minTools >= 1 ? input.minTools : 1
  const catalogPlacement = input.catalogPlacement === 'section' ? 'section' : 'context'
  const index = INDEX_STYLES.has(input.index) ? input.index : 'names'
  const scope = SCOPES.has(input.scope) ? input.scope : 'mcp'
  const core = Array.isArray(input.core)
    ? input.core.filter((name) => typeof name === 'string' && name.length > 0)
    : [...DEFAULT_CORE]
  const otherGroup = typeof input.otherGroup === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(input.otherGroup)
    ? input.otherGroup
    : 'other'
  const descriptionChars = Number.isInteger(input.descriptionChars) && input.descriptionChars >= 10
    ? input.descriptionChars
    : 40
  const maxIndexChars = Number.isInteger(input.maxIndexChars) && input.maxIndexChars >= 200
    ? input.maxIndexChars
    : 4000
  const healthGraceMs = Number.isInteger(input.healthGraceMs) && input.healthGraceMs >= 0
    ? input.healthGraceMs
    : 15000
  const healthProbe = input.healthProbe !== false
  const healthProbeTimeoutMs = Number.isInteger(input.healthProbeTimeoutMs) && input.healthProbeTimeoutMs >= 100
    ? input.healthProbeTimeoutMs
    : 3000
  const healthProbeCacheMs = Number.isInteger(input.healthProbeCacheMs) && input.healthProbeCacheMs >= 0
    ? input.healthProbeCacheMs
    : 5000
  // Background health pass. Zero disables it, in which case `list` and the
  // panel carry no transport annotation at all (fail-quiet, never fail-loud).
  const healthMonitorMs = Number.isInteger(input.healthMonitorMs) && input.healthMonitorMs >= 0
    ? Math.max(input.healthMonitorMs, input.healthMonitorMs === 0 ? 0 : 5000)
    : 30000
  // A connection-shaped tool failure is evidence for one call, not forever:
  // either the next successful call or this TTL clears it.
  const failureTtlMs = Number.isInteger(input.failureTtlMs) && input.failureTtlMs >= 0
    ? input.failureTtlMs
    : 300000
  // How often the expected-server memory rewrites `lastSeen` on disk.
  const expectedTouchMs = Number.isInteger(input.expectedTouchMs) && input.expectedTouchMs >= 0
    ? input.expectedTouchMs
    : 300000
  const stateFile = typeof input.stateFile === 'string' ? input.stateFile.trim() : ''
  // Remember every MCP server that was ever configured, so a server whose row
  // later disappears from the profile (an editor rewriting the whole patch file
  // is the usual cause) shows up as "missing" in the panel instead of vanishing.
  const expectedFile = typeof input.expectedFile === 'string'
    ? input.expectedFile.trim()
    : '~/.dsh/mcp-lazy-expected.json'

  return {
    enabled: input.enabled !== false,
    toolName,
    scope,
    core,
    otherGroup,
    minTools,
    servers,
    alwaysLoaded,
    catalogPlacement,
    index,
    descriptionChars,
    maxIndexChars,
    healthGraceMs,
    healthProbe,
    healthProbeTimeoutMs,
    healthProbeCacheMs,
    healthMonitorMs,
    failureTtlMs,
    expectedTouchMs,
    stateFile,
    expectedFile,
    autoSummary: input.autoSummary !== false,
    restoreOnResume: input.restoreOnResume !== false,
    allowUnload: input.allowUnload !== false,
  }
}

/**
 * Whether one registry tool participates in this plugin's deferral policy.
 *
 * `scope: "mcp"` manages only the `mcp__*` namespace. `scope: "all"` manages
 * every global tool except the meta tool and the configured `core` allowlist;
 * that is the registry-wide policy that covers tools from every plugin, not
 * just MCP.
 *
 * @param {string} toolName - model-facing tool name.
 * @param {ReturnType<typeof resolveConfig>} config - resolved plugin config.
 * @returns {boolean} whether the tool is managed.
 */
export function isManagedToolName(toolName, config) {
  if (typeof toolName !== 'string' || toolName.length === 0) return false
  if (toolName === config.toolName) return false
  if (config.scope === 'mcp') return toolName.startsWith(MCP_PREFIX)
  if (config.core.includes(toolName)) return false
  return true
}

/**
 * Group one managed tool. MCP names route to their server (falling back to the
 * `otherGroup` when the public name cannot be parsed); every other managed tool
 * belongs to the `otherGroup`.
 *
 * @param {string} toolName - model-facing tool name.
 * @param {ReturnType<typeof resolveConfig>} config - resolved plugin config.
 * @returns {string} group name.
 */
export function groupOf(toolName, config) {
  if (toolName.startsWith(MCP_PREFIX)) {
    return serverOf(toolName, Object.keys(config.servers)) ?? config.otherGroup
  }
  return config.otherGroup
}

/**
 * Group managed tool schemas into deferral groups.
 *
 * In `scope: "mcp"` the groups are MCP servers. In `scope: "all"` every
 * non-core tool is managed: MCP tools keep their server group and other tools
 * share `otherGroup`. Tools that cannot be attributed to any group are left
 * out: the catalog could not offer a group to load, and hiding them without a
 * route back would make them uncallable.
 *
 * @param {readonly { name: string, description?: string }[]} schemas - model-facing schemas.
 * @param {ReturnType<typeof resolveConfig>} config - resolved plugin config.
 * @returns {CatalogIndex} grouped, name-sorted catalog.
 */
export function buildIndex(schemas, config) {
  const knownServers = Object.keys(config.servers)
  const servers = new Map()
  const names = []
  for (const schema of Array.isArray(schemas) ? schemas : []) {
    if (schema === null || typeof schema !== 'object' || typeof schema.name !== 'string') continue
    if (!isManagedToolName(schema.name, config)) continue
    const group = groupOf(schema.name, config)
    if (group === undefined || group.length === 0) continue
    let entry = servers.get(group)
    if (entry === undefined) {
      entry = { name: group, summary: config.servers[group]?.summary ?? '', tools: [], bytes: 0 }
      servers.set(group, entry)
    }
    const bytes = JSON.stringify(schema).length
    entry.tools.push({
      name: schema.name,
      description: typeof schema.description === 'string' ? schema.description : '',
      bytes,
    })
    entry.bytes += bytes
    names.push(schema.name)
  }
  for (const entry of servers.values()) {
    entry.tools.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  }
  const sorted = new Map([...servers.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
  names.sort()
  return { servers: sorted, names }
}

/**
 * Compute the exact global tool names one agent must have hidden.
 *
 * A server contributes its tools only while it is unrevealed, not
 * `alwaysLoaded`, and at or above `minTools`; small servers stay resident.
 *
 * @param {CatalogIndex} index - current catalog.
 * @param {ReadonlySet<string>} revealed - servers this agent has loaded.
 * @param {ReturnType<typeof resolveConfig>} config - resolved plugin config.
 * @param {ReadonlySet<string>} [disabled] - servers switched off in the MCP panel.
 * @returns {string[]} sorted deny list; empty means no restriction is needed.
 */
export function computeDenyNames(index, revealed, config, disabled = new Set()) {
  const deny = []
  for (const entry of index.servers.values()) {
    const off = disabled.has(entry.name)
    if (!off && revealed.has(entry.name)) continue
    if (!off && config.alwaysLoaded.includes(entry.name)) continue
    if (!off && entry.tools.length < config.minTools) continue
    for (const tool of entry.tools) deny.push(tool.name)
  }
  deny.sort()
  return deny
}

/**
 * One-line summary for a server, truncated for the stable catalog.
 * @param {ServerEntry} entry - server catalog entry.
 * @param {ReturnType<typeof resolveConfig>} config - resolved plugin config.
 * @returns {string} display summary.
 */
export function summaryOf(entry, config) {
  const summary = entry.summary || `${entry.tools.length} tools`
  return summary.length > config.descriptionChars ? `${summary.slice(0, config.descriptionChars - 1)}…` : summary
}

/** Escape one literal string for a regular expression. */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Derive a catalog summary from an MCP server's own instructions.
 *
 * `dsh-mcp-client` registers `### MCP server: <name>` plus the server's
 * instructions as a prompt section. The first sentence is a good one-line
 * purpose without an LLM call. The configured `servers.<name>` summary always
 * wins; this is only a fallback.
 *
 * @param {unknown} text - resolved `mcp:<server>` section text.
 * @param {string} serverName - server name used in the heading.
 * @returns {string} first sentence, or an empty string.
 */
export function summarizeInstructions(text, serverName) {
  if (typeof text !== 'string') return ''
  const heading = new RegExp(`^\\s*#{1,6}\\s*MCP server:\\s*${escapeRegExp(serverName)}\\s*`, 'i')
  const value = text
    .replace(heading, '')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (value.length === 0) return ''
  const sentence = value.split(/(?<=[.!?。！？])\s+/)[0] ?? value
  return sentence.trim()
}

/**
 * Classify one MCP tool result as a transport failure.
 *
 * Deliberately narrow: a remote tool is allowed to report its own timeout or
 * rejection without that counting as a broken bridge. Only the wording the MCP
 * client and the Node transport actually produce for a dead connection matches,
 * and a TTL plus every successful call clear the verdict.
 *
 * @param {unknown} text - serialized result content.
 * @returns {boolean} whether this looks like a lost connection.
 */
export function isConnectionFailure(text) {
  if (typeof text !== 'string' || text.length === 0) return false
  return /not connected|connection (?:closed|lost|refused|terminated|reset)|econnrefused|econnreset|econnaborted|ehostunreach|fetch failed|socket hang up|socket (?:closed|timeout)|transport (?:closed|error)|mcp error -32000/i.test(text)
}

/**
 * Classify one server's transport health from evidence the Host really has.
 *
 * Precedence is deliberate. A fresh tool-call failure outranks a probe, because
 * a HEAD request never opens an MCP session and therefore says nothing about
 * whether the bridge can talk to it. A *repeated* probe failure outranks "tools
 * are registered", because `dsh-mcp-client` keeps stale definitions after a
 * transport loss — but one failed HEAD is not enough: proxies, DNS hiccups and
 * token expiry all produce a single miss, and flagging those turns the badge
 * into noise. A server with no tools yet is only "connecting" inside the grace
 * window; after that it is unavailable, and a reachable endpoint with zero tools
 * is reported as its own reason so the panel can say what is wrong.
 *
 * @param {object} input - observations for one server.
 * @param {number} [input.toolCount] - managed tools currently registered.
 * @param {boolean} [input.configured] - whether an MCP client row exists.
 * @param {number} [input.ageMs] - time since this Host first saw the server.
 * @param {number} [input.graceMs] - startup grace window.
 * @param {number} [input.failureAgeMs] - age of the last connection-like failure.
 * @param {number} [input.failureTtlMs] - how long such a failure stays evidence.
 * @param {{ ok: boolean, status: number, failures?: number } | undefined} [input.probe] - probe result.
 * @returns {{ health: string, reason: string | undefined }} verdict.
 */
export function assessHealth(input = {}) {
  const toolCount = Number.isInteger(input.toolCount) ? input.toolCount : 0
  const configured = input.configured === true
  const ageMs = Number.isFinite(input.ageMs) ? input.ageMs : 0
  const graceMs = Number.isFinite(input.graceMs) ? input.graceMs : 0
  const failureFresh = Number.isFinite(input.failureAgeMs)
    && input.failureAgeMs >= 0
    && input.failureAgeMs <= (Number.isFinite(input.failureTtlMs) ? input.failureTtlMs : 0)
  const probe = input.probe
  // A single failed HEAD is inconclusive; two in a row (about a minute at the
  // default cadence) is evidence. Probes that never reported a streak count as 1.
  const probeDown = probe !== undefined && probe.ok !== true && (probe.failures ?? 1) >= 2

  if (toolCount > 0) {
    if (failureFresh) return { health: 'unavailable', reason: 'call-failed' }
    if (probeDown) return { health: 'unavailable', reason: 'unreachable' }
    return { health: 'ok', reason: undefined }
  }
  if (failureFresh) return { health: 'unavailable', reason: 'call-failed' }
  if (configured && ageMs < graceMs) return { health: 'connecting', reason: undefined }
  if (probe !== undefined && probe.ok === true) return { health: 'unavailable', reason: 'no-tools' }
  return { health: 'unavailable', reason: 'unavailable' }
}

/**
 * One short clause appended to a `list` line when a server is not healthy, so
 * the model can avoid calling a bridge that is currently down.
 *
 * @param {{ health: string, reason?: string } | undefined} record - health snapshot entry.
 * @returns {string} empty when healthy, otherwise `; health: ...`.
 */
export function healthNote(record) {
  if (record === undefined || record === null) return ''
  if (record.health !== 'unavailable' && record.health !== 'missing') return ''
  const detail = record.reason === 'call-failed'
    ? 'the last tool call could not reach it'
    : record.reason === 'unreachable'
      ? 'the endpoint probe failed'
      : record.reason === 'no-tools'
        ? 'reachable but it registered no tools'
        : 'not connected'
  return `; health: ${record.health} (${detail})`
}

/**
 * Rough token estimate for schema bytes. The 4-characters-per-token ratio is
 * the same one DSH's own tooling uses for compact estimates.
 * @param {number} bytes - UTF-16 character count of the schema JSON.
 * @returns {string} compact display, for example `47.1k`.
 */
export function formatTokens(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0'
  const tokens = bytes / 4
  if (tokens < 1000) return String(Math.max(1, Math.round(tokens)))
  return `${(tokens / 1000).toFixed(1)}k`
}

/**
 * Render the stable system-prompt catalog. Bytes stay identical while the MCP
 * registry and configured summaries do not change, which is what keeps the
 * prompt prefix cacheable across turns.
 *
 * The header is intentionally explicit: a model that missed the meta tool must
 * still learn that MCP tools are hidden and how to load them.
 *
 * @param {CatalogIndex} index - current catalog.
 * @param {ReturnType<typeof resolveConfig>} config - resolved plugin config.
 * @param {ReadonlySet<string>} [disabled] - servers switched off in the MCP panel.
 * @returns {string} catalog text, or an empty string without servers.
 */
export function renderCatalog(index, config, disabled = new Set()) {
  const visible = [...index.servers.values()].filter((entry) => !disabled.has(entry.name))
  if (visible.length === 0) return ''
  const all = config.scope === 'all'
  const lines = [
    all ? '## Deferred tools (lazy)' : '## MCP servers (lazy)',
    all
      ? `Deferred tools are hidden until loaded. Call ${config.toolName}({action:"load",server:"<group>"}) before using a hidden tool; ${config.toolName}({action:"list"}) shows state. Do not claim a capability is unavailable before loading its group.`
      : `MCP tools are hidden until loaded. Call ${config.toolName}({action:"load",server:"<name>"}) before using any mcp__<server>__ tool; ${config.toolName}({action:"list"}) shows state. Do not claim an MCP capability is unavailable before loading it.`,
  ]
  for (const entry of visible) {
    const label = entry.summary ? `${summaryOf(entry, config)} (${entry.tools.length} tools)` : `${entry.tools.length} tools`
    lines.push(`- ${entry.name}: ${label}`)
  }
  return lines.join('\n')
}

/**
 * Render the `list` action for one agent. Hidden servers report their estimated
 * schema cost so the caller can see what is being kept out of context.
 *
 * @param {CatalogIndex} index - current catalog.
 * @param {ReadonlySet<string>} revealed - servers this agent has loaded.
 * @param {ReturnType<typeof resolveConfig>} config - resolved plugin config.
 * @param {ReadonlySet<string>} [disabled] - servers switched off in the MCP panel.
 * @param {ReadonlyMap<string, { health: string, reason?: string }>} [health] - transport snapshot.
 * @returns {string} human/model-facing list.
 */
export function renderList(index, revealed, config, disabled = new Set(), health = new Map()) {
  const visible = [...index.servers.values()].filter((entry) => !disabled.has(entry.name))
  if (visible.length === 0) return config.scope === 'all' ? 'No deferred tool groups are currently registered.' : 'No MCP servers are currently registered.'
  const lines = [config.scope === 'all' ? 'Deferred tool groups:' : 'MCP servers:']
  for (const entry of visible) {
    const loaded = revealed.has(entry.name)
    const resident = entry.tools.length < config.minTools || config.alwaysLoaded.includes(entry.name)
    const state = resident ? 'always visible' : loaded ? 'loaded' : 'hidden'
    const cost = `≈${formatTokens(entry.bytes)} tokens`
    const suffix = resident ? '' : loaded ? ' in context' : ' hidden'
    const label = entry.summary ? `${summaryOf(entry, config)} (${entry.tools.length} tools)` : `${entry.tools.length} tools`
    lines.push(`- ${entry.name}: ${label} — ${state}, ${cost}${suffix}${healthNote(health.get(entry.name))}`)
  }
  return lines.join('\n')
}

/**
 * Render the `load` action result. The full schemas arrive in the NEXT request
 * through the ordinary tool-addition path; the tool index here only names what
 * was enabled.
 *
 * @param {ServerEntry} entry - server that was just revealed.
 * @param {ReturnType<typeof resolveConfig>} config - resolved plugin config.
 * @param {{ health: string, reason?: string } | undefined} [health] - transport snapshot entry.
 * @returns {string} load confirmation and bounded tool index.
 */
export function renderLoad(entry, config, health) {
  const count = entry.tools.length
  const head = `Loaded "${entry.name}": ${count} tools become callable from the next step. Do not call tools from this group in this step; their full parameter schemas appear in the next request.`
  const note = healthNote(health)
  if (note !== '') {
    return `${head}\n\nWarning: this server currently looks down — ${note.replace(/^; /, '')}. Calls may fail until it reconnects; ${config.toolName}({action:"list"}) shows the latest state.`
  }
  if (config.index === 'none' || count === 0) return head
  const lines = [head, 'Tools:']
  let characters = head.length
  let listed = 0
  for (const tool of entry.tools) {
    const description = tool.description.replace(/\s+/g, ' ').trim()
    const line = config.index === 'summary'
      ? `- ${tool.name}: ${description.length > config.descriptionChars ? `${description.slice(0, config.descriptionChars - 1)}…` : description}`
      : `- ${tool.name}`
    if (characters + line.length > config.maxIndexChars) break
    lines.push(line)
    characters += line.length + 1
    listed += 1
  }
  if (listed < count) lines.push(`… ${count - listed} more (omitted; full list is in the next request's tools)`)
  return lines.join('\n')
}

/**
 * Whether an action is one of the accepted meta-tool actions.
 * @param {unknown} action - raw argument.
 * @returns {boolean} whether it is valid.
 */
export function isAction(action) {
  return typeof action === 'string' && ACTION_NAMES.has(action)
}

/**
 * Collapse every layer the Host knows about into one row per MCP server, each
 * carrying exactly one lifecycle status.
 *
 * The point is that the route handler stops deciding what a row means. Five
 * sources disagree in five ways (the loader knows intent, the registry knows
 * connections, the mirror knows history, the health map knows answers, the panel
 * knows switches), and every extra `if` used to be a place where a new state
 * could silently fall through — the settings page returning HTTP 500 was exactly
 * that. Here the precedence is written once:
 *
 * - `removed`        mirror only — neither a loader row nor a registered tool;
 * - `unconfigured`   tools without a loader row — another plugin, or a scan we
 *                    could not complete;
 * - `down`           registered but not answering, or configured and past grace;
 * - `connecting`     configured, no tools yet, still inside the grace window;
 * - `always-visible` registered, but disclosed unconditionally (below `minTools`
 *                    or listed in `alwaysLoaded`);
 * - `active`         registered and lazily disclosed — the normal case;
 * - `unknown`        the loader scan itself failed, so "absent" cannot be told
 *                    apart from "unreadable". Never reported as `removed`.
 *
 * @param {object} [input] - observations for one Host.
 * @param {Map<string, object>} [input.configured] - loader rows by server name.
 * @param {CatalogIndex} [input.index] - current tool index.
 * @param {Map<string, object>} [input.expected] - mirror of every server ever seen.
 * @param {ReadonlySet<string>} [input.disabled] - servers switched off in the panel.
 * @param {Map<string, object>} [input.health] - latest verdict per server.
 * @param {ReturnType<typeof resolveConfig>} [input.config] - resolved plugin config.
 * @param {{ ok: boolean, error?: string | null }} [input.scan] - result of the loader scan.
 * @param {Map<string, { phase: string, attempt?: number, error?: string | null, at?: number }>} [input.asyncStatus] - progress reported by deferred client rows (`dsh-mcp-lazy/async`).
 * @returns {{ servers: object[], counts: Record<string, number>, scan: { ok: boolean, error: string | null } }} inventory.
 */
export function buildInventory(input = {}) {
  const configured = input.configured instanceof Map ? input.configured : new Map()
  const expected = input.expected instanceof Map ? input.expected : new Map()
  const disabled = input.disabled instanceof Set ? input.disabled : new Set()
  const health = input.health instanceof Map ? input.health : new Map()
  const asyncStatus = input.asyncStatus instanceof Map ? input.asyncStatus : new Map()
  const index = input.index ?? {}
  const servers = index.servers instanceof Map ? index.servers : new Map()
  const config = input.config ?? {}
  const scan = input.scan ?? { ok: true, error: null }
  const scanFailed = scan.ok === false
  const minTools = Number.isInteger(config.minTools) ? config.minTools : 1
  const alwaysLoaded = Array.isArray(config.alwaysLoaded) ? config.alwaysLoaded : []
  const configuredSummaries = config.servers ?? {}

  const names = [...new Set([...configured.keys(), ...servers.keys(), ...expected.keys()])].sort()
  const counts = { active: 0, 'always-visible': 0, down: 0, connecting: 0, removed: 0, unconfigured: 0, unknown: 0 }
  const rows = []

  for (const name of names) {
    const row = configured.get(name)
    const entry = servers.get(name)
    const remembered = expected.get(name)
    const record = health.get(name)
    const async = asyncStatus.get(name)
    const toolCount = entry === undefined ? 0 : entry.tools.length
    const resident = entry !== undefined && (toolCount < minTools || alwaysLoaded.includes(name))
    const verdict = record?.health ?? (toolCount > 0 ? 'ok' : 'connecting')
    const summary = entry !== undefined
      ? summaryOf(entry, config)
      : configuredSummaries[name]?.summary
        || remembered?.summary
        || row?.description
        || ''

    let status
    let reason
    // A loader that returned rows is in use; a loader that returned nothing may
    // simply not be part of this host (presets, embedded hosts). Only in the
    // former case does "tools but no row" mean something is unaccounted for.
    const loaderActive = configured.size > 0
    if (entry === undefined && row === undefined) {
      // Neither live layer knows this name. A failed scan cannot assert removal:
      // it only means the configuration was unreadable this time.
      status = scanFailed ? 'unknown' : 'removed'
      reason = scanFailed ? 'scan-failed' : 'configured-missing'
    } else if (entry !== undefined && verdict === 'unavailable') {
      // A call that could not reach the server outranks every bookkeeping
      // question: the server is down, whatever its row looks like.
      status = 'down'
      reason = record?.reason ?? 'unavailable'
    } else if (entry !== undefined && row === undefined) {
      if (scanFailed) {
        status = 'unknown'
        reason = 'scan-failed'
      } else if (loaderActive) {
        status = 'unconfigured'
        reason = 'not-configured'
      } else {
        status = resident ? 'always-visible' : 'active'
        reason = resident ? 'disclosure-inactive' : undefined
      }
    } else if (entry !== undefined) {
      status = resident ? 'always-visible' : 'active'
      reason = resident ? 'disclosure-inactive' : undefined
    } else if (async !== undefined && (async.phase === 'loading' || async.phase === 'starting' || async.phase === 'connecting')) {
      // A deferred row exists but has registered no tools yet. The wrapper
      // reports its own progress, so "still on the way" is an observation
      // rather than a guess based on a grace window.
      status = 'connecting'
      reason = undefined
    } else if (async !== undefined && async.phase === 'credentials') {
      status = 'down'
      reason = 'waiting-credentials'
    } else if (async !== undefined && (async.phase === 'failed' || async.phase === 'closed')) {
      status = 'down'
      reason = async.phase === 'failed' ? 'startup-failed' : 'closed'
    } else if (verdict === 'connecting') {
      status = 'connecting'
      reason = undefined
    } else {
      status = 'down'
      reason = record?.reason ?? 'unavailable'
    }

    const mechanism = entry !== undefined
      ? (resident ? 'always-visible' : 'lazy')
      : status === 'removed'
        ? 'missing'
        : row === undefined
          ? 'unconfigured'
          : 'lazy'
    counts[status] = (counts[status] ?? 0) + 1
    rows.push({
      name,
      status,
      enabled: !disabled.has(name),
      summary,
      toolCount,
      tokens: entry === undefined ? 0 : Math.round(entry.bytes / 4),
      mechanism,
      health: status === 'removed' ? 'missing' : verdict,
      disclosureActive: entry !== undefined && !resident,
      abnormal: status !== 'active' && status !== 'connecting',
      reason,
      // The wrapper's own phase, kept next to the verdict so the panel can say
      // what is happening ("首次连接中") without re-deriving it from counts.
      phase: async?.phase ?? null,
      // No tools and still connecting: this server has never been usable in
      // this Host, which is a different situation from a reconnect.
      firstConnect: toolCount === 0 && status === 'connecting',
      transport: row?.transport ?? remembered?.transport ?? '',
      probeStatus: record?.probeStatus ?? null,
      firstSeen: remembered?.firstSeen ?? null,
      lastSeen: remembered?.lastSeen ?? null,
      checkedAt: record?.checkedAt ?? null,
    })
  }

  return {
    servers: rows,
    counts,
    scan: { ok: !scanFailed, error: scanFailed ? (scan.error ?? 'unknown error') : null },
  }
}
