import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../index.js'

const REA_A = { name: 'mcp__rea__inspect_binary_layout', description: 'Inspect a binary.' }
const REA_B = { name: 'mcp__rea__open_binary', description: 'Open a binary.' }
const READ = { name: 'read', description: 'Read a file.' }

/**
 * Minimal Cordis-shaped Host context: captures registrations and exposes the
 * public methods the plugin uses, without starting a Harness.
 */
function makeHarness(rawSchemas) {
  const schemas = [...rawSchemas]
  const registered = []
  const restrictions = []
  const guards = []
  const sections = []
  const contexts = []
  const routes = []
  const listeners = new Map()
  const warnings = []
  const loaderEntries = []
  let cleanup = undefined

  const agent = {
    id: 'agent-1',
    ctx: {
      tools: {
        restrict(filter) {
          const record = { deny: filter.deny === undefined ? undefined : [...filter.deny], disposed: false }
          restrictions.push(record)
          return () => {
            record.disposed = true
          }
        },
      },
    },    session: {
      toolHistory: () => ({ tools: [], updates: [] }),
    },
  }

  const ctx = {
    loader: { entries: () => loaderEntries },
    tools: {
      schemas: () => schemas,
      register(definition) {
        registered.push(definition)
        return () => {
          definition.disposed = true
        }
      },
      guard(guard) {
        guards.push(guard)
        return () => {
          guards.splice(guards.indexOf(guard), 1)
        }
      },
      // The capability check requires the Service method; this plugin restricts
      // through `agent.ctx.tools.restrict`, never the global view.
      restrict() {
        return () => {}
      },
      get() {
        return undefined
      },
    },
    agents: { list: () => [agent] },
    systemPrompt: {
      getSectionOrder: () => 100,
      section(section) {
        sections.push(section)
        return () => {
          section.disposed = true
        }
      },
      context(context) {
        contexts.push(context)
        return () => {
          context.disposed = true
        }
      },
    },
    logger: {
      warn: (message) => warnings.push(message),
      debug: () => {},
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        listeners.set(event, (listeners.get(event) ?? []).filter((entry) => entry !== listener))
      }
    },
    effect(factory) {
      cleanup = factory()
      return () => {
        cleanup?.()
      }
    },
    inject(_services, callback) {
      callback({
        webServer: {
          register(route) {
            routes.push(route)
            return () => {}
          },
        },
        effect(factory) {
          const dispose = factory()
          return () => dispose?.()
        },
      })
      return () => {}
    },
  }

  const emit = (event, ...args) => {
    for (const listener of listeners.get(event) ?? []) listener(...args)
  }

  /**
   * Apply the plugin with test-safe defaults: no persistence to the real
   * `~/.dsh` files (switch state *and* expected mirror), and no background
   * timer unless a test asks for one.
   * @param {object} [config] - plugin config overrides.
   * @returns {void}
   */
  const applyPlugin = (config = {}) => apply(ctx, { expectedFile: '', stateFile: '', healthMonitorMs: 0, ...config })

  return { ctx, agent, schemas, registered, restrictions, guards, sections, contexts, routes, listeners, warnings, loaderEntries, emit, apply: applyPlugin, cleanup: () => cleanup?.() }
}

test('apply registers the meta tool, catalog, restriction, and self-heal guard', () => {
  const h = makeHarness([REA_A, REA_B, READ])
  h.apply({ servers: { rea: 'reverse engineering' }, catalogPlacement: 'section' })

  assert.equal(h.registered.length, 1)
  const meta = h.registered[0]
  assert.equal(meta.name, 'mcp')

  assert.equal(h.sections.length, 1)
  const catalog = h.sections[0].text()
  assert.match(catalog, /^## MCP servers \(lazy\)$/m)
  assert.match(catalog, /Call mcp\(\{action:"load",server:"<name>"\}\)/)
  assert.match(catalog, /^- rea: reverse engineering \(2 tools\)$/m)

  assert.equal(h.restrictions.length, 1)
  assert.deepEqual(h.restrictions[0].deny, [REA_A.name, REA_B.name])

  assert.equal(h.guards.length, 1)
  const guard = h.guards[0]
  assert.match(guard({ name: REA_A.name, agent: h.agent }), /mcp\(\{action:"load",server:"rea"\}\)/)
  assert.equal(guard({ name: READ.name, agent: h.agent }), undefined)
  assert.match(guard({ name: 'mcp__other__x', agent: h.agent }), /Unknown MCP tool/)
  assert.match(guard({ name: 'mcp__rea__typo', agent: h.agent }), /Unknown tool/)
  assert.deepEqual(h.warnings, [])
})

test('list exposes the hidden cost; load removes the restriction; unload restores it', async () => {
  const h = makeHarness([REA_A, REA_B, READ])
  h.apply({ servers: { rea: 'reverse engineering' }, catalogPlacement: 'section' })
  const meta = h.registered[0]

  const list = await meta.execute({ action: 'list' }, { agent: h.agent })
  assert.match(list.text, /rea: reverse engineering \(2 tools\) — hidden, ≈\d+ tokens hidden/)

  await meta.execute({ action: 'load', server: 'rea' }, { agent: h.agent })
  assert.equal(h.restrictions[0].disposed, true)
  assert.equal(h.restrictions.length, 1)
  const loaded = await meta.execute({ action: 'list' }, { agent: h.agent })
  assert.match(loaded.text, /2 tools\) — loaded, ≈\d+ tokens in context/)
  assert.equal(h.guards[0]({ name: REA_A.name, agent: h.agent }), undefined)

  await meta.execute({ action: 'unload', server: 'rea' }, { agent: h.agent })
  assert.equal(h.restrictions.length, 2)
  assert.deepEqual(h.restrictions[1].deny, [REA_A.name, REA_B.name])
  assert.match(h.guards[0]({ name: REA_A.name, agent: h.agent }), /Deferred group "rea" is not loaded/)

  await assert.rejects(() => meta.execute({ action: 'load', server: 'nope' }, { agent: h.agent }), /unknown deferred group/)
  await assert.rejects(() => meta.execute({ action: 'load' }, { agent: h.agent }), /requires "server"/)
  await assert.rejects(() => meta.execute({ action: 'nope' }, { agent: h.agent }), /unknown action/)
})

test('a newly registered MCP server is hidden by default and gets a catalog line', async () => {
  const h = makeHarness([REA_A, REA_B, READ])
  h.apply({ servers: { rea: 'reverse engineering' }, catalogPlacement: 'section' })
  const meta = h.registered[0]

  h.schemas.push({ name: 'mcp__fresh__do_work', description: 'Do work.' })
  h.emit('tools/change')

  assert.equal(h.restrictions.length, 2)
  assert.deepEqual(h.restrictions[1].deny, ['mcp__fresh__do_work', REA_A.name, REA_B.name])
  assert.match(h.sections[0].text(), /^- fresh: 1 tools$/m)
  const list = await meta.execute({ action: 'list' }, { agent: h.agent })
  assert.match(list.text, /fresh: 1 tools — hidden,/)
  assert.match(h.guards[0]({ name: 'mcp__fresh__do_work', agent: h.agent }), /server:"fresh"/)
})

test('default catalog placement is the runtime context', () => {
  const h = makeHarness([REA_A, REA_B, READ])
  h.apply({ servers: { rea: 'reverse engineering' } })
  assert.equal(h.sections.length, 0)
  assert.equal(h.contexts.length, 1)
  assert.equal(h.contexts[0].name, 'mcp-lazy:catalog')
  assert.equal(h.contexts[0].required, true)
  assert.match(h.contexts[0].text(), /^## MCP servers \(lazy\)$/m)
})

test('scope all hides every non-core tool, including non-MCP plugin tools', async () => {
  const h = makeHarness([
    READ,
    REA_A,
    { name: 'thirdparty_tool', description: 'A plugin tool.' },
  ])
  h.apply({ scope: 'all', core: ['read'], servers: { rea: 'reverse engineering' } })
  const meta = h.registered[0]

  assert.deepEqual(h.restrictions[0].deny, [REA_A.name, 'thirdparty_tool'])
  const list = await meta.execute({ action: 'list' }, { agent: h.agent })
  assert.match(list.text, /^Deferred tool groups:$/m)
  assert.match(list.text, /other: 1 tools/)
  assert.match(list.text, /rea: reverse engineering/)
  assert.match(h.guards[0]({ name: 'thirdparty_tool', agent: h.agent }), /server:"other"/)
  assert.equal(h.guards[0]({ name: 'read', agent: h.agent }), undefined)

  await meta.execute({ action: 'load', server: 'other' }, { agent: h.agent })
  assert.equal(h.restrictions[0].disposed, true)
  assert.equal(h.guards[0]({ name: 'thirdparty_tool', agent: h.agent }), undefined)
})

test('auto summary comes from the MCP server instructions when config is empty', async () => {
  const h = makeHarness([REA_A, REA_B, READ])
  h.apply({ catalogPlacement: 'section' })
  const meta = h.registered[0]

  const listener = h.listeners.get('system-prompt/assemble')?.[0]
  assert.equal(typeof listener, 'function')
  const resolved = await listener(null, null, async () => ({
    tools: [],
    contexts: [],
    sections: [
      { name: 'mcp-lazy:catalog', text: '## MCP servers (lazy)' },
      { name: 'mcp:rea', text: '### MCP server: rea\n\nREA is a reverse-engineering toolkit. More text.' },
    ],
  }))
  assert.ok(Array.isArray(resolved.sections))

  const list = await meta.execute({ action: 'list' }, { agent: h.agent })
  assert.match(list.text, /rea: REA is a reverse-engineering toolkit\. \(2 tools\)/)
})

test('settings route returns catalog-exact summaries and marks abnormal servers', async () => {
  const h = makeHarness([REA_A, REA_B, READ])
  h.apply({ servers: { rea: 'reverse engineering' }, catalogPlacement: 'section' })
  assert.ok(h.routes.some((route) => route.path === '/mcp-lazy/servers'))
  assert.ok(h.routes.some((route) => route.path === '/mcp-lazy/toggle'))
  const route = h.routes.find((candidate) => candidate.path === '/mcp-lazy/servers')
  assert.equal(route.path, '/mcp-lazy/servers')

  let status = 0
  let body = ''
  const res = {
    writeHead(code) {
      status = code
    },
    end(value) {
      body = value ?? ''
    },
  }
  await route.handler({ socket: { remoteAddress: '127.0.0.1' }, method: 'GET' }, res)
  assert.equal(status, 200)
  const payload = JSON.parse(body)
  assert.equal(payload.servers.length, 1)
  assert.equal(payload.servers[0].name, 'rea')
  assert.equal(payload.servers[0].summary, 'reverse engineering')
  assert.equal(payload.servers[0].toolCount, 2)
  assert.equal(payload.servers[0].abnormal, false)

  status = 0
  await route.handler({ socket: { remoteAddress: '10.0.0.2' }, method: 'GET' }, res)
  assert.equal(status, 403)
})

test('the MCP panel switch hides and restores one server disclosure', async () => {
  const h = makeHarness([REA_A, REA_B, READ])
  h.apply({ servers: { rea: 'reverse engineering' }, catalogPlacement: 'section' })
  const toggle = h.routes.find((route) => route.path === '/mcp-lazy/toggle')
  const get = h.routes.find((route) => route.path === '/mcp-lazy/servers')
  const meta = h.registered[0]

  const callToggle = async (enabled) => {
    let status = 0
    let body = ''
    const req = {
      socket: { remoteAddress: '127.0.0.1' },
      method: 'POST',
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify({ name: 'rea', enabled }))
      },
    }
    const res = {
      writeHead(code) {
        status = code
      },
      end(value) {
        body = value ?? ''
      },
    }
    await toggle.handler(req, res)
    assert.equal(status, 200)
    return JSON.parse(body)
  }

  const snapshot = async () => {
    let body = ''
    const res = {
      writeHead() {},
      end(value) {
        body = value ?? ''
      },
    }
    await get.handler({ socket: { remoteAddress: '127.0.0.1' }, method: 'GET' }, res)
    return JSON.parse(body).servers.find((server) => server.name === 'rea')
  }

  await callToggle(false)
  assert.equal((await snapshot()).enabled, false)
  assert.doesNotMatch(h.sections[0].text(), /rea/)
  const listed = await meta.execute({ action: 'list' }, { agent: h.agent })
  assert.doesNotMatch(listed.text, /rea/)
  await assert.rejects(
    () => meta.execute({ action: 'load', server: 'rea' }, { agent: h.agent }),
    /disabled/,
  )

  await callToggle(true)
  assert.equal((await snapshot()).enabled, true)
  assert.match(h.sections[0].text(), /rea/)
  const loaded = await meta.execute({ action: 'load', server: 'rea' }, { agent: h.agent })
  assert.match(loaded.text, /Loaded "rea"/)
})

test('settings route marks configured servers that never connected', async () => {
  const h = makeHarness([REA_A, REA_B, READ])
  h.loaderEntries.push({
    options: {
      name: '@deepseek-ai/dsh-mcp-client',
      config: { serverName: 'dead', transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp' },
    },
    disabled: false,
  })
  h.apply({ servers: { rea: 'reverse engineering' }, catalogPlacement: 'section', healthGraceMs: 0 })
  const route = h.routes[0]
  const res = {
    writeHead() {},
    end() {},
  }
  let body = ''
  res.end = (value) => {
    body = value ?? ''
  }
  await route.handler({ socket: { remoteAddress: '127.0.0.1' }, method: 'GET' }, res)
  const payload = JSON.parse(body)
  const dead = payload.servers.find((server) => server.name === 'dead')
  assert.ok(dead)
  assert.equal(dead.health, 'unavailable')
  assert.equal(dead.abnormal, true)
  assert.equal(dead.reason, 'unavailable')
  assert.equal(dead.toolCount, 0)
  assert.equal(dead.summary, '')
})

test('a connection-like tool failure marks the server unhealthy until a success', async () => {
  const h = makeHarness([REA_A, REA_B, READ])
  h.apply({ servers: { rea: 'reverse engineering' }, catalogPlacement: 'section', healthProbe: false })
  const route = h.routes[0]
  let body = ''
  const res = {
    writeHead() {},
    end(value) {
      body = value ?? ''
    },
  }

  h.emit('tools/result', { name: REA_A.name }, {
    isError: true,
    content: [{ type: 'text', text: 'MCP client is not connected' }],
  })
  await route.handler({ socket: { remoteAddress: '127.0.0.1' }, method: 'GET' }, res)
  let rea = JSON.parse(body).servers.find((server) => server.name === 'rea')
  assert.equal(rea.health, 'unavailable')
  assert.equal(rea.reason, 'call-failed')
  assert.equal(rea.abnormal, true)

  h.emit('tools/result', { name: REA_A.name }, { isError: false, content: [] })
  await route.handler({ socket: { remoteAddress: '127.0.0.1' }, method: 'GET' }, res)
  rea = JSON.parse(body).servers.find((server) => server.name === 'rea')
  assert.equal(rea.health, 'ok')
  assert.equal(rea.abnormal, false)
})

test('an unreachable HTTP probe marks a server that still has stale tools', async () => {
  const h = makeHarness([REA_A, REA_B, READ])
  h.loaderEntries.push({
    options: {
      name: '@deepseek-ai/dsh-mcp-client',
      config: { serverName: 'rea', transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp' },
    },
    disabled: false,
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('connection refused')
  }
  try {
    h.apply({ servers: { rea: 'reverse engineering' }, catalogPlacement: 'section', healthProbe: true, healthProbeTimeoutMs: 500, healthProbeCacheMs: 0 })
    const route = h.routes[0]
    let body = ''
    const res = {
      writeHead() {},
      end(value) {
        body = value ?? ''
      },
    }
    const get = async () => {
      body = ''
      await route.handler({ socket: { remoteAddress: '127.0.0.1' }, method: 'GET' }, res)
      return JSON.parse(body)
    }
    // One failed HEAD is a flake: the registered tools still count as evidence.
    const first = (await get()).servers.find((server) => server.name === 'rea')
    assert.equal(first.health, 'ok')
    // Two in a row is a verdict.
    const rea = (await get()).servers.find((server) => server.name === 'rea')
    assert.equal(rea.health, 'unavailable')
    assert.equal(rea.reason, 'unreachable')
    assert.equal(rea.abnormal, true)
    assert.equal(rea.probeStatus, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('agent disposal disposes the restriction and clears the guard state', () => {
  const h = makeHarness([REA_A, REA_B, READ])
  h.apply({ servers: { rea: 'reverse engineering' } })
  assert.equal(h.restrictions.length, 1)
  h.emit('agent/disposed', { agent: h.agent })
  assert.equal(h.restrictions[0].disposed, true)
  assert.equal(h.guards[0]({ name: REA_A.name, agent: h.agent }), undefined)
})

/** A loader row shaped like the one `@deepseek-ai/dsh-mcp-client` registers. */
function loaderRow(serverName, transport = 'stdio', extra = {}) {
  return {
    options: { name: '@deepseek-ai/dsh-mcp-client', config: { serverName, transport, ...extra } },
    disabled: false,
  }
}

/** An isolated expected-mirror file so tests never touch `~/.dsh`. */
function tempExpected() {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-lazy-'))
  return { file: join(dir, 'expected.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function answer() {
  const out = { status: 0, body: '' }
  out.res = {
    writeHead(code) {
      out.status = code
    },
    end(value) {
      out.body = value ?? ''
    },
  }
  return out
}

async function getServers(h) {
  const route = h.routes.find((candidate) => candidate.path === '/mcp-lazy/servers')
  const out = answer()
  await route.handler({ socket: { remoteAddress: '127.0.0.1' }, method: 'GET' }, out.res)
  return JSON.parse(out.body)
}

async function postRoute(h, path, value) {
  const route = h.routes.find((candidate) => candidate.path === path)
  const out = answer()
  const req = {
    socket: { remoteAddress: '127.0.0.1' },
    method: 'POST',
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(value))
    },
  }
  await route.handler(req, out.res)
  return { status: out.status, body: out.body }
}

test('the expected mirror records configured servers without the panel being opened', () => {
  const t = tempExpected()
  try {
    const h = makeHarness([REA_A, REA_B, READ])
    h.loaderEntries.push(loaderRow('auto'))
    h.apply({ expectedFile: t.file })

    const mirror = JSON.parse(readFileSync(t.file, 'utf8'))
    // Configured servers and servers with registered tools both belong in the
    // mirror: the second kind is what makes a later disappearance visible.
    assert.deepEqual(Object.keys(mirror.servers), ['auto', 'rea'])
    assert.equal(mirror.servers.auto.transport, 'stdio')
    assert.equal(typeof mirror.servers.auto.firstSeen, 'string')
    // Only route registration happened; GET was never called.
    assert.equal(h.routes.length, 3)
  } finally {
    t.cleanup()
  }
})

test('the lastSeen heartbeat is throttled so panel polling does not rewrite the file', async () => {
  const t = tempExpected()
  try {
    const h = makeHarness([REA_A, REA_B, READ])
    h.loaderEntries.push(loaderRow('auto'))
    h.apply({ expectedFile: t.file, expectedTouchMs: 60000 })
    // Let the start-up health pass settle before sampling the baseline.
    await new Promise((resolve) => setTimeout(resolve, 10))
    const first = JSON.parse(readFileSync(t.file, 'utf8')).servers.auto.lastSeen

    await getServers(h)
    await getServers(h)
    assert.equal(JSON.parse(readFileSync(t.file, 'utf8')).servers.auto.lastSeen, first)
  } finally {
    t.cleanup()
  }
})

test('forget removes a tombstone but refuses a server that still exists', async () => {
  const t = tempExpected()
  try {
    writeFileSync(
      t.file,
      JSON.stringify({
        servers: { gone: { summary: 'old run', transport: 'stdio', firstSeen: 'a', lastSeen: 'b' } },
      }),
    )
    const h = makeHarness([REA_A, REA_B, READ])
    h.loaderEntries.push(loaderRow('rea'))
    h.apply({ expectedFile: t.file, servers: { rea: 'reverse engineering' } })

    let payload = await getServers(h)
    const gone = payload.servers.find((server) => server.name === 'gone')
    assert.ok(gone)
    assert.equal(gone.health, 'missing')
    assert.equal(gone.reason, 'configured-missing')
    assert.equal(gone.abnormal, true)

    const refused = await postRoute(h, '/mcp-lazy/forget', { name: 'rea' })
    assert.equal(refused.status, 409)
    assert.match(refused.body, /refusing/)
    assert.equal((await postRoute(h, '/mcp-lazy/forget', { name: 'gone' })).status, 200)
    payload = await getServers(h)
    assert.equal(payload.servers.some((server) => server.name === 'gone'), false)
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(t.file, 'utf8')).servers, 'gone'), false)
  } finally {
    t.cleanup()
  }
})

test('mcp list and mcp load warn the model about a server that is down', async () => {
  const h = makeHarness([REA_A, REA_B, READ])
  h.apply({ servers: { rea: 'reverse engineering' }, catalogPlacement: 'section', healthProbe: false })

  h.emit('tools/result', { name: REA_A.name }, {
    isError: true,
    content: [{ type: 'text', text: 'fetch failed' }],
  })

  const list = await h.registered[0].execute({ action: 'list' }, { agent: h.agent })
  assert.match(list.text, /health: unavailable \(the last tool call could not reach it\)/)

  const load = await h.registered[0].execute({ action: 'load', server: 'rea' }, { agent: h.agent })
  assert.match(load.text, /currently looks down/)
  assert.match(load.text, /mcp\(\{action:"list"\}\) shows the latest state/)
})

test('the prompt audit sees tools admitted outside the index and rebuilds it', async () => {
  const h = makeHarness([REA_A, READ])
  h.apply({ servers: { rea: 'reverse engineering' }, catalogPlacement: 'section' })
  assert.doesNotMatch(h.sections[0].text(), /late/)

  // A tool appeared in the registry without a tools/change notification, so the
  // index is stale; only the toolSet exposed at assemble time knows about it.
  h.schemas.push({ name: 'mcp__late__do_work', description: 'Do work.' })
  const listener = h.listeners.get('system-prompt/assemble')[0]
  const admitted = new Map([['mcp__late__do_work', { name: 'mcp__late__do_work' }]])
  await listener(
    null,
    { toolSet: { view: () => admitted }, scope: 'scope' },
    async () => ({ tools: [], sections: [], contexts: [] }),
  )
  await new Promise((resolve) => setTimeout(resolve, 5))

  assert.match(h.sections[0].text(), /^- late: 1 tools$/m)
})

test('resume restores a runtime-discovered server, not only configured ones', async () => {
  const h = makeHarness([{ name: 'mcp__auto__do_work', description: 'Do work.' }])
  h.agent.session.toolHistory = () => ({
    tools: [],
    updates: [{ messageId: 'm1', additions: [{ name: 'mcp__auto__do_work' }] }],
  })
  h.apply({})

  const list = await h.registered[0].execute({ action: 'list' }, { agent: h.agent })
  assert.match(list.text, /auto: 1 tools — loaded/)
  // The restored server is not hidden, so no deny list is needed at all.
  assert.equal(h.restrictions.some((record) => record.disposed === false), false)
})

test('a failing loader scan is reported as unknown, never as removed', async () => {
  const t = tempExpected()
  try {
    writeFileSync(
      t.file,
      JSON.stringify({
        servers: { gone: { summary: 'old run', transport: 'stdio', firstSeen: 'a', lastSeen: 'b' } },
      }),
    )
    const h = makeHarness([REA_A, REA_B, READ])
    // A row that blows up while being read stands in for a loader that is
    // itself broken (renamed internals, a disposed context, ...). The plugin
    // must say "I could not read the configuration", not "you deleted them".
    const boom = {}
    Object.defineProperty(boom, 'options', {
      get() {
        throw new Error('loader gone')
      },
    })
    h.loaderEntries.push(boom)
    h.apply({ expectedFile: t.file })

    const payload = await getServers(h)
    assert.equal(payload.scan.ok, false)
    assert.match(payload.scan.error, /loader gone/)

    const gone = payload.servers.find((server) => server.name === 'gone')
    assert.equal(gone.status, 'unknown')
    assert.equal(gone.reason, 'scan-failed')
    assert.equal(gone.abnormal, true)
    assert.equal(payload.counts.removed, 0)
    assert.ok(payload.counts.unknown >= 1)
  } finally {
    t.cleanup()
  }
})
