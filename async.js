/**
 * Deferred MCP client row.
 *
 * `@deepseek-ai/dsh-mcp-client` deliberately blocks its own activation on the
 * first connection (`await connection.ready`), so a slow or unreachable MCP
 * server delays the whole Host — and the desktop shell only shows its window
 * once the Host reports ready. This wrapper keeps the same per-server config
 * but starts the real client on a child fiber *without* awaiting it, so the
 * Host finishes booting, the window appears, and the MCP connection proceeds
 * in the background.
 *
 * Everything else stays the client's: the config schema, the tool names, the
 * reconnect policy, the `serverName` reservation, and teardown (the child
 * fiber is an effect of this one). The panel learns what is happening through
 * `./async-status.js`, which is how "configured but still connecting" stays a
 * visible state instead of looking like a missing server.
 *
 * @module
 */

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PHASE, clearStatus, publishStatus } from './async-status.js'

/** Loader-visible plugin name. */
export const name = 'mcp-client-async'

/** The deferred client still needs the tool registry to publish into. */
export const inject = ['tools']

const CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'

/** Path inside an Electron install, relative to `process.resourcesPath`. */
const INSTALL_HINT = [
  'app.asar',
  'dsh',
  'node_modules',
  ...CLIENT_PACKAGE.split('/'),
  'lib',
  'index.js',
]

/** @type {Record<string, unknown> | undefined} */
let cachedClient

/**
 * Resolve the real client package from an anchor that lives beside the Host's
 * own `node_modules`.
 *
 * A plugin installed through a `link:` dependency is loaded from its source
 * directory, which has no `node_modules` of the Host — a bare `import()` here
 * would resolve against the wrong tree. The Host entry (`process.argv[1]`) and
 * the Electron executable both sit inside that tree, so `createRequire` on
 * either anchor finds the same package the loader would.
 *
 * @returns {Promise<Record<string, unknown>>} the client module namespace.
 */
async function loadClient() {
  if (cachedClient !== undefined) return cachedClient
  const problems = []
  const anchors = [process.argv[1], process.execPath].filter(
    (anchor) => typeof anchor === 'string' && anchor !== '',
  )
  for (const anchor of anchors) {
    try {
      const require = createRequire(anchor)
      const file = require.resolve(CLIENT_PACKAGE)
      cachedClient = await import(pathToFileURL(file).href)
      return cachedClient
    } catch (error) {
      problems.push(`${anchor}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  try {
    const resources = process.resourcesPath
    if (typeof resources === 'string' && resources !== '') {
      const file = join(resources, ...INSTALL_HINT)
      if (existsSync(file)) {
        cachedClient = await import(pathToFileURL(file).href)
        return cachedClient
      }
      problems.push(`${file}: not found`)
    }
  } catch (error) {
    problems.push(`resources: ${error instanceof Error ? error.message : String(error)}`)
  }
  throw new Error(`cannot load ${CLIENT_PACKAGE} (${problems.join(' | ') || 'no resolution anchor'})`)
}

/**
 * Translate one client connection status into the panel's vocabulary.
 * @param {{ state?: string, attempt?: number, lastError?: string }} status - client status.
 * @returns {{ phase: string, attempt: number, error: string | null }} registry patch.
 */
function describe(status) {
  const state = typeof status?.state === 'string' ? status.state : 'connecting'
  const attempt = Number.isInteger(status?.attempt) ? status.attempt : 0
  const error = typeof status?.lastError === 'string' ? status.lastError : null
  if (state === 'connected') return { phase: PHASE.connected, attempt, error: null }
  if (state === 'failed') return { phase: PHASE.failed, attempt, error }
  if (state === 'waiting-credentials') return { phase: PHASE.credentials, attempt, error }
  if (state === 'closed') return { phase: PHASE.closed, attempt, error }
  return { phase: PHASE.connecting, attempt, error }
}

/**
 * How long to wait for the deferred instance to register its status cell.
 * The client creates the cell inside its own `apply`, which runs a microtask
 * after `ctx.plugin()` returns, so the first read is almost always empty.
 */
const BRIDGE_POLL_MS = 100

/** Give up polling after this many intervals (~10 s). */
const BRIDGE_POLL_TRIES = 100

/**
 * Mirror the deferred instance's connection status into the panel registry.
 *
 * Reads the cell until it exists, then publishes the current status and every
 * transition. Nothing here gates activation: a missing cell only costs the
 * panel its precise wording, and tool counts still drive the verdict.
 *
 * @param {object} deps - collaborators.
 * @param {Record<string, unknown>} deps.client - the client module namespace.
 * @param {object} deps.fiber - the child fiber returned by `ctx.plugin()`.
 * @param {string} deps.server - MCP `serverName`.
 * @param {string} deps.label - log prefix.
 * @param {() => boolean} deps.stopped - whether this wrapper was unloaded.
 * @param {(disposer: () => void, name: string) => void} deps.effect - registers a disposer on the wrapper fiber.
 * @param {import('@deepseek-ai/cordis').Context['logger']} [deps.logger] - logger.
 */
function attachStatusBridge({ client, fiber, server, label, stopped, effect, logger }) {
  let timer
  let tries = 0
  const attempt = () => {
    timer = undefined
    if (stopped()) return
    let handle
    try {
      handle = client.connectionStatusOf?.(fiber)
    } catch {
      return
    }
    if (handle === undefined) {
      tries += 1
      if (tries >= BRIDGE_POLL_TRIES) {
        logger?.warn?.(`${label}: the client never registered a status cell; the panel falls back to tool counts`)
        return
      }
      timer = setTimeout(attempt, BRIDGE_POLL_MS)
      timer.unref?.()
      return
    }
    publishStatus(server, describe(handle.current()))
    effect(() => handle.onChange((status) => publishStatus(server, describe(status))), 'mcp-client-async.connection')
  }
  attempt()
  effect(() => () => {
    if (timer !== undefined) clearTimeout(timer)
  }, 'mcp-client-async.bridge-timer')
}

/**
 * Register one deferred MCP client.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ serverName?: string } & Record<string, unknown>} config - the row config, passed through unchanged.
 */
export function apply(ctx, config) {
  const server = typeof config?.serverName === 'string' ? config.serverName : ''
  const label = `mcp-client-async(${server || 'unnamed'})`
  if (server === '') {
    ctx.logger?.warn?.(`${label}: config.serverName is required; the row cannot be tracked or connected`)
    return
  }

  publishStatus(server, { phase: PHASE.loading, attempt: 0, error: null })

  let stopped = false
  // The child fiber is registered as an effect of this fiber (cordis ties a
  // fork to its parent), so this only needs to mark the handoff as dead.
  ctx.effect(() => () => {
    stopped = true
    clearStatus(server)
  }, 'mcp-client-async.status')
  const isStopped = () => stopped

  // Deliberately detached: activation of THIS plugin must not wait for the
  // import, the connection, or the initial tool sync.
  void (async () => {
    let client
    try {
      client = await loadClient()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      publishStatus(server, { phase: PHASE.failed, error: message })
      ctx.logger?.error?.(`${label}: ${message}`)
      return
    }
    if (stopped) return

    publishStatus(server, { phase: PHASE.starting, attempt: 0, error: null })
    let fiber
    try {
      // The module namespace is a valid cordis plugin: it carries `apply`,
      // `name`, `inject`, and the client's own `Config` schema, so the row's
      // config is validated exactly as an ordinary mcp-client row would be.
      fiber = ctx.plugin(client, config)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      publishStatus(server, { phase: PHASE.failed, error: message })
      ctx.logger?.error?.(`${label}: ${message}`)
      return
    }

    attachStatusBridge({
      client, fiber, server, label, stopped: isStopped, logger: ctx.logger,
      effect: (disposer, name) => ctx.effect(disposer, name),
    })

    // Observe the child's activation without gating anything on it.
    Promise.resolve(fiber).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      const current = client.connectionStatusOf?.(fiber)?.current()
      publishStatus(server, { phase: PHASE.failed, error: current?.lastError ?? message })
      ctx.logger?.warn?.(`${label}: deferred connection failed: ${message}`)
    })
  })()
}
