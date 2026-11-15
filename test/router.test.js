import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assessHealth,
  buildIndex,
  buildInventory,
  computeDenyNames,
  DEFAULT_CORE,
  formatTokens,
  groupOf,
  healthNote,
  isAction,
  isConnectionFailure,
  isManagedToolName,
  renderCatalog,
  renderList,
  renderLoad,
  resolveConfig,
  serverOf,
  summarizeInstructions,
  summaryOf,
} from '../lib/router.js'

const schemas = [
  { name: 'read', description: 'Read a file.' },
  { name: 'mcp__rea__inspect_binary_layout', description: 'Inspect a binary.' },
  { name: 'mcp__rea__open_binary', description: 'Open a binary.' },
  { name: 'mcp__github__create_issue', description: 'Create an issue.' },
  { name: 'mcp__my_server__do_work', description: 'Do work.' },
]

test('serverOf resolves configured names first, then the first segment', () => {
  assert.equal(serverOf('mcp__rea__open_binary'), 'rea')
  assert.equal(serverOf('mcp__my_server__do_work', ['my_server']), 'my_server')
  assert.equal(serverOf('mcp__my_server__do_work'), 'my_server')
  assert.equal(serverOf('mcp__my__server__do_work'), 'my')
  assert.equal(serverOf('mcp__my__server__do_work', ['my__server']), 'my__server')
  assert.equal(serverOf('read'), undefined)
  assert.equal(serverOf('mcp__'), undefined)
  assert.equal(serverOf(undefined), undefined)
})

test('resolveConfig applies defaults and rejects malformed values', () => {
  const defaults = resolveConfig()
  assert.equal(defaults.toolName, 'mcp')
  assert.equal(defaults.minTools, 1)
  assert.equal(defaults.scope, 'mcp')
  assert.equal(defaults.catalogPlacement, 'context')
  assert.equal(defaults.index, 'names')
  assert.equal(defaults.enabled, true)
  assert.deepEqual(defaults.servers, {})
  assert.equal(defaults.autoSummary, true)
  assert.equal(defaults.healthGraceMs, 15000)
  assert.equal(defaults.healthProbe, true)
  assert.equal(defaults.healthProbeTimeoutMs, 3000)
  assert.equal(defaults.healthProbeCacheMs, 5000)
  assert.equal(defaults.healthMonitorMs, 30000)
  assert.equal(defaults.failureTtlMs, 300000)
  assert.equal(defaults.expectedTouchMs, 300000)
  assert.ok(defaults.core.includes('read'))
  assert.ok(DEFAULT_CORE.includes('mcp'))

  const resolved = resolveConfig({
    toolName: '../bad name',
    minTools: 0,
    catalogPlacement: 'context',
    index: 'bogus',
    descriptionChars: 2,
    servers: { rea: 'reverse engineering', other: { summary: 'other tools' }, ignored: 3 },
    alwaysLoaded: ['rea', 7],
    restoreOnResume: false,
    allowUnload: false,
  })
  assert.equal(resolved.toolName, 'mcp')
  assert.equal(resolved.minTools, 1)
  assert.equal(resolved.catalogPlacement, 'context')
  assert.equal(resolved.scope, 'mcp')
  assert.equal(resolved.index, 'names')
  assert.equal(resolved.descriptionChars, 40)
  assert.deepEqual(resolved.servers, { rea: { summary: 'reverse engineering' }, other: { summary: 'other tools' } })
  assert.deepEqual(resolved.alwaysLoaded, ['rea'])
  assert.equal(resolved.restoreOnResume, false)
  assert.equal(resolved.allowUnload, false)
})

test('buildIndex groups only attributable MCP tools', () => {
  const config = resolveConfig({ servers: { rea: 'reverse engineering', github: 'issues' }, minTools: 1 })
  const index = buildIndex(schemas, config)
  assert.deepEqual([...index.servers.keys()], ['github', 'my_server', 'rea'])
  assert.deepEqual(index.servers.get('rea').tools.map((tool) => tool.name), [
    'mcp__rea__inspect_binary_layout',
    'mcp__rea__open_binary',
  ])
  assert.equal(index.names.length, 4)
  assert.equal(index.servers.has('my_server'), true)
  assert.ok(index.servers.get('rea').bytes > 0)
  assert.ok(index.servers.get('rea').tools[0].bytes > 0)
  assert.equal(index.servers.get('rea').bytes, index.servers.get('rea').tools.reduce((sum, tool) => sum + tool.bytes, 0))
})

test('computeDenyNames honours revealed, alwaysLoaded, and minTools', () => {
  const config = resolveConfig({ servers: { rea: 'reverse engineering', github: 'issues' }, minTools: 2 })
  const index = buildIndex(schemas, config)
  assert.deepEqual(computeDenyNames(index, new Set(), config), ['mcp__rea__inspect_binary_layout', 'mcp__rea__open_binary'])
  assert.deepEqual(computeDenyNames(index, new Set(['rea']), config), [])

  const always = resolveConfig({
    servers: { rea: 'reverse engineering', github: 'issues', my_server: 'work' },
    minTools: 1,
    alwaysLoaded: ['rea', 'github', 'my_server'],
  })
  assert.deepEqual(computeDenyNames(buildIndex(schemas, always), new Set(), always), [])

  // A panel switch overrides revealed/alwaysLoaded: off means hidden.
  assert.deepEqual(
    computeDenyNames(index, new Set(['rea']), config, new Set(['rea'])),
    ['mcp__rea__inspect_binary_layout', 'mcp__rea__open_binary'],
  )
})

test('renderCatalog is stable and one line per server', () => {
  const config = resolveConfig({ servers: { rea: 'reverse engineering' }, minTools: 1 })
  const index = buildIndex(schemas, config)
  const first = renderCatalog(index, config)
  assert.equal(first, renderCatalog(index, config))
  assert.match(first, /^## MCP servers \(lazy\)$/m)
  assert.match(first, /Call mcp\(\{action:"load",server:"<name>"\}\)/)
  assert.match(first, /^- rea: reverse engineering \(2 tools\)$/m)
  assert.equal(renderCatalog(buildIndex([], config), config), '')
  assert.doesNotMatch(renderCatalog(index, config, new Set(['rea'])), /rea/)
  assert.equal(renderCatalog(index, config, new Set([...index.servers.keys()])), '')
})

test('summarizeInstructions strips the mcp heading and keeps one sentence', () => {
  assert.equal(
    summarizeInstructions('### MCP server: rea\n\nREA is a reverse-engineering toolkit. More text follows.', 'rea'),
    'REA is a reverse-engineering toolkit.',
  )
  assert.equal(summarizeInstructions('', 'rea'), '')
  assert.equal(summarizeInstructions('Plain purpose text.', 'rea'), 'Plain purpose text.')
  assert.equal(summarizeInstructions('### MCP server: rea\n\n', 'rea'), '')
})

test('formatTokens compacts schema estimates', () => {
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(4), '1')
  assert.equal(formatTokens(4000), '1.0k')
  assert.equal(formatTokens(188464), '47.1k')
})

test('summaryOf truncates with a single ellipsis', () => {
  const config = resolveConfig({ descriptionChars: 10 })
  assert.equal(summaryOf({ summary: 'abcdefghijklmno' }, config), 'abcdefghi…')
  assert.equal(summaryOf({ tools: [{ name: 'a' }] }, config), '1 tools')
})

test('renderList reports per-agent state and hidden schema cost', () => {
  const config = resolveConfig({ servers: { rea: 'reverse engineering' }, minTools: 1 })
  const index = buildIndex(schemas, config)
  assert.match(renderList(index, new Set(), config), /rea: reverse engineering \(2 tools\) — hidden, ≈\d+ tokens hidden/)
  assert.match(renderList(index, new Set(['rea']), config), /rea: reverse engineering \(2 tools\) — loaded, ≈\d+ tokens in context/)
  const resident = resolveConfig({ servers: { rea: 'reverse engineering' }, minTools: 99 })
  assert.match(renderList(buildIndex(schemas, resident), new Set(), resident), /always visible, ≈\d+ tokens/)
  const switchedOff = renderList(index, new Set(), config, new Set(['rea']))
  assert.doesNotMatch(switchedOff, /rea/)
  assert.match(switchedOff, /github/)
})

test('scope all manages every non-core tool through one registry-wide policy', () => {
  const config = resolveConfig({ scope: 'all', core: ['read'], servers: { rea: 'reverse engineering' }, minTools: 1 })
  const index = buildIndex([
    { name: 'read', description: 'Read a file.' },
    { name: 'mcp__rea__open_binary', description: 'Open a binary.' },
    { name: 'thirdparty_tool', description: 'A plugin tool.' },
  ], config)
  assert.deepEqual([...index.servers.keys()], ['other', 'rea'])
  assert.deepEqual(index.names, ['mcp__rea__open_binary', 'thirdparty_tool'])
  assert.equal(isManagedToolName('read', config), false)
  assert.equal(isManagedToolName('thirdparty_tool', config), true)
  assert.equal(isManagedToolName('mcp', config), false)
  assert.equal(groupOf('thirdparty_tool', config), 'other')
  assert.equal(groupOf('mcp__rea__open_binary', config), 'rea')
  assert.deepEqual(computeDenyNames(index, new Set(), config), ['mcp__rea__open_binary', 'thirdparty_tool'])
  const catalog = renderCatalog(index, config)
  assert.match(catalog, /^## Deferred tools \(lazy\)$/m)
  assert.match(catalog, /^- other: 1 tools$/m)
  assert.match(catalog, /^- rea: reverse engineering \(1 tools\)$/m)
  assert.match(renderList(index, new Set(), config), /^Deferred tool groups:$/m)
  assert.match(renderLoad(index.servers.get('other'), config), /tools become callable from the next step/)
})

test('renderLoad bounds the index and states the next-step rule', () => {
  const config = resolveConfig({ minTools: 1, index: 'summary', maxIndexChars: 400 })
  const index = buildIndex(schemas, config)
  const text = renderLoad(index.servers.get('rea'), config)
  assert.match(text, /become callable from the next step/)
  assert.match(text, /Do not call tools from this group in this step/)
  assert.match(text, /- mcp__rea__open_binary/)
  assert.ok(text.length <= 460)
})

test('isAction accepts only the three documented actions', () => {
  assert.equal(isAction('list'), true)
  assert.equal(isAction('load'), true)
  assert.equal(isAction('unload'), true)
  assert.equal(isAction('call'), false)
  assert.equal(isAction(undefined), false)
})

test('isConnectionFailure matches transport wording only', () => {
  assert.equal(isConnectionFailure('MCP client is not connected'), true)
  assert.equal(isConnectionFailure('Error: connect ECONNREFUSED 127.0.0.1:9'), true)
  assert.equal(isConnectionFailure('fetch failed'), true)
  assert.equal(isConnectionFailure('socket hang up'), true)
  assert.equal(isConnectionFailure('McpError: MCP error -32000: Connection closed'), true)
  // A remote tool's own failure must not be blamed on the transport.
  assert.equal(isConnectionFailure('ValidationError: missing field "owner"'), false)
  assert.equal(isConnectionFailure('the query returned no rows'), false)
  assert.equal(isConnectionFailure(''), false)
  assert.equal(isConnectionFailure(undefined), false)
})

test('assessHealth ranks call failure over probe over tool presence', () => {
  const base = { configured: true, ageMs: 60000, graceMs: 15000, failureTtlMs: 300000 }
  // Healthy: tools exist, probe fine.
  assert.deepEqual(assessHealth({ ...base, toolCount: 3, probe: { ok: true, status: 200 } }), { health: 'ok', reason: undefined })
  // A live tool call that cannot reach the server outranks a passing HEAD.
  assert.deepEqual(
    assessHealth({ ...base, toolCount: 3, failureAgeMs: 1000, probe: { ok: true, status: 200 } }),
    { health: 'unavailable', reason: 'call-failed' },
  )
  // One failed HEAD is a flake, not a verdict: tools stay trusted.
  assert.deepEqual(
    assessHealth({ ...base, toolCount: 3, probe: { ok: false, status: 0, failures: 1 } }),
    { health: 'ok', reason: undefined },
  )
  // Two failures in a row outrank stale tool definitions.
  assert.deepEqual(
    assessHealth({ ...base, toolCount: 3, probe: { ok: false, status: 0, failures: 2 } }),
    { health: 'unavailable', reason: 'unreachable' },
  )
  // Expired failure evidence is ignored.
  assert.equal(assessHealth({ ...base, toolCount: 3, failureAgeMs: 400000, probe: { ok: true, status: 200 } }).health, 'ok')
  // Still inside the start-up grace window.
  assert.deepEqual(assessHealth({ ...base, toolCount: 0, ageMs: 1000 }), { health: 'connecting', reason: undefined })
  // Grace over, nothing registered: down.
  assert.deepEqual(assessHealth({ ...base, toolCount: 0 }), { health: 'unavailable', reason: 'unavailable' })
  // Reachable endpoint that registers no tools is its own diagnosis.
  assert.deepEqual(
    assessHealth({ ...base, toolCount: 0, probe: { ok: true, status: 200 } }),
    { health: 'unavailable', reason: 'no-tools' },
  )
  // Configured-but-unreachable with no tools.
  assert.deepEqual(
    assessHealth({ ...base, toolCount: 0, probe: { ok: false, status: 502 } }),
    { health: 'unavailable', reason: 'unavailable' },
  )
})

test('healthNote only annotates servers that are actually down', () => {
  assert.equal(healthNote({ health: 'ok' }), '')
  assert.equal(healthNote({ health: 'connecting' }), '')
  assert.equal(healthNote(undefined), '')
  assert.match(healthNote({ health: 'unavailable', reason: 'call-failed' }), /the last tool call could not reach it/)
  assert.match(healthNote({ health: 'unavailable', reason: 'no-tools' }), /registered no tools/)
  assert.match(healthNote({ health: 'missing' }), /health: missing/)
})

test('renderList and renderLoad surface a down server to the model', () => {
  const config = resolveConfig({ servers: { rea: 'reverse engineering' }, minTools: 1 })
  const index = buildIndex(schemas, config)
  const health = new Map([['rea', { health: 'unavailable', reason: 'call-failed' }]])
  const list = renderList(index, new Set(), config, new Set(), health)
  assert.match(list, /rea: reverse engineering \(2 tools\) — hidden, ≈\d+ tokens hidden; health: unavailable/)
  assert.doesNotMatch(list, /github.*health:/)
  const loaded = renderLoad(index.servers.get('rea'), config, health.get('rea'))
  assert.match(loaded, /currently looks down/)
  assert.match(loaded, /mcp\(\{action:"list"\}\) shows the latest state/)
  assert.doesNotMatch(renderLoad(index.servers.get('rea'), config, { health: 'ok' }), /looks down/)
})

const inventorySchemas = [
  { name: 'mcp__rea__a', description: 'A.' },
  { name: 'mcp__rea__b', description: 'B.' },
  { name: 'mcp__tiny__a', description: 'Only tool.' },
  { name: 'mcp__mcd__a', description: 'C.' },
  { name: 'mcp__mcd__b', description: 'D.' },
]

test('buildInventory gives every server exactly one status', () => {
  const config = resolveConfig({ servers: { rea: 'reverse engineering', tiny: 'one tool' }, minTools: 2 })
  const index = buildIndex(inventorySchemas, config)
  const configured = new Map([
    ['rea', { name: 'rea', transport: 'stdio', url: '', description: 'reverse engineering' }],
    ['tiny', { name: 'tiny', transport: 'stdio', url: '', description: '' }],
    ['mcd', { name: 'mcd', transport: 'streamable-http', url: 'https://example.invalid', description: '' }],
    ['slow', { name: 'slow', transport: 'stdio', url: '', description: '' }],
  ])
  const expected = new Map([
    ['rea', { summary: '', transport: 'stdio', firstSeen: 'a', lastSeen: 'b' }],
    ['gone', { summary: 'deleted once', transport: 'stdio', firstSeen: 'c', lastSeen: 'd' }],
  ])
  const health = new Map([
    ['mcd', { health: 'unavailable', reason: 'call-failed', checkedAt: 1, probeStatus: 0 }],
    ['slow', { health: 'connecting', checkedAt: 2 }],
  ])
  const inventory = buildInventory({ configured, index, expected, disabled: new Set(['tiny']), health, config })
  const byName = new Map(inventory.servers.map((row) => [row.name, row]))

  // Registered and lazily disclosed.
  assert.equal(byName.get('rea').status, 'active')
  assert.equal(byName.get('rea').abnormal, false)
  assert.equal(byName.get('rea').disclosureActive, true)
  assert.equal(byName.get('rea').mechanism, 'lazy')
  // Registered but below minTools -> always visible.
  assert.equal(byName.get('tiny').status, 'always-visible')
  assert.equal(byName.get('tiny').abnormal, true)
  assert.equal(byName.get('tiny').enabled, false)
  // A failed call outranks "tools are registered".
  assert.equal(byName.get('mcd').status, 'down')
  assert.equal(byName.get('mcd').reason, 'call-failed')
  assert.equal(byName.get('mcd').toolCount, 2)
  // Configured, nothing registered, still inside the grace window.
  assert.equal(byName.get('slow').status, 'connecting')
  assert.equal(byName.get('slow').abnormal, false)
  // Mirror only: reported, never hidden, and never counted as live.
  assert.equal(byName.get('gone').status, 'removed')
  assert.equal(byName.get('gone').health, 'missing')
  assert.equal(byName.get('gone').reason, 'configured-missing')
  assert.equal(byName.get('gone').summary, 'deleted once')
  assert.equal(inventory.counts.active, 1)
  assert.equal(inventory.counts['always-visible'], 1)
  assert.equal(inventory.counts.down, 1)
  assert.equal(inventory.counts.connecting, 1)
  assert.equal(inventory.counts.removed, 1)
  assert.deepEqual(inventory.scan, { ok: true, error: null })
})

test('buildInventory never calls a row removed when the loader scan failed', () => {
  const config = resolveConfig({ servers: {} })
  const index = buildIndex([], config)
  const expected = new Map([['rea', { summary: 's', transport: 'stdio', firstSeen: 'a', lastSeen: 'b' }]])
  const inventory = buildInventory({
    configured: new Map(),
    index,
    expected,
    config,
    scan: { ok: false, error: 'loader gone' },
  })
  assert.equal(inventory.servers.length, 1)
  assert.equal(inventory.servers[0].status, 'unknown')
  assert.equal(inventory.servers[0].reason, 'scan-failed')
  assert.equal(inventory.servers[0].abnormal, true)
  assert.deepEqual(inventory.scan, { ok: false, error: 'loader gone' })
  assert.equal(inventory.counts.removed, 0)
  assert.equal(inventory.counts.unknown, 1)
})

test('buildInventory reports registered tools with no loader row only when the loader is in use', () => {
  const config = resolveConfig({ servers: {} })
  const index = buildIndex(inventorySchemas, config)

  // No loader rows at all: this host may simply not use the loader, so the
  // registry-only view is reported as normal instead of as an anomaly.
  const registryOnly = buildInventory({ configured: new Map(), index, config })
  assert.equal(registryOnly.servers.find((row) => row.name === 'rea').status, 'active')

  // The loader returned rows for other servers, so a name with none is a real
  // gap: tools exist that no configuration row accounts for.
  const partial = buildInventory({
    configured: new Map([['slow', { name: 'slow', transport: 'stdio', url: '', description: '' }]]),
    index,
    config,
    health: new Map([['slow', { health: 'connecting', checkedAt: 1 }]]),
  })
  assert.equal(partial.servers.find((row) => row.name === 'rea').status, 'unconfigured')
  assert.equal(partial.servers.find((row) => row.name === 'rea').reason, 'not-configured')
  assert.equal(partial.servers.find((row) => row.name === 'slow').status, 'connecting')
})
