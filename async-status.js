/**
 * Status registry shared by the deferred MCP wrapper and the MCP panel.
 *
 * The wrapper (`./async.js`) starts a real `@deepseek-ai/dsh-mcp-client`
 * instance on a child fiber after the Host is already serving the window, so
 * the panel needs a way to say "configured, connecting, no tools yet" without
 * inventing evidence. Both modules live in this package, but they are loaded
 * as separate ESM entries — a module-level Map would give each one its own
 * copy. `globalThis` with a registered symbol keeps a single registry per
 * process, survives reloads of either module, and needs no Host service that a
 * plain plugin could not otherwise reach.
 *
 * @module
 */

/** Phases a deferred MCP client reports. */
export const PHASE = Object.freeze({
  /** The module has not been reached yet; nothing is connecting. */
  loading: 'loading',
  /** The client module resolved; the child fiber is about to be created. */
  starting: 'starting',
  /** The client owns a live connection attempt. */
  connecting: 'connecting',
  /** Connected, tools registered. */
  connected: 'connected',
  /** Waiting for credentials declared by the server configuration. */
  credentials: 'credentials',
  /** Retries exhausted, or the instance could not start at all. */
  failed: 'failed',
  /** The client was disposed. */
  closed: 'closed',
})

const SLOT = Symbol.for('dsh.mcp-lazy.async-status')

/** @type {Map<string, { phase: string, attempt: number, error: string | null, at: number }>} */
const registry = (globalThis[SLOT] ??= new Map())

/**
 * Merge one observation into a server's status.
 * @param {string} server - MCP `serverName`.
 * @param {{ phase: string, attempt?: number, error?: string | null }} patch - fields to record.
 */
export function publishStatus(server, patch) {
  if (typeof server !== 'string' || server === '') return
  const previous = registry.get(server)
  registry.set(server, {
    phase: typeof patch.phase === 'string' ? patch.phase : previous?.phase ?? PHASE.loading,
    attempt: Number.isInteger(patch.attempt) ? patch.attempt : previous?.attempt ?? 0,
    error: patch.error === undefined ? previous?.error ?? null : patch.error,
    at: Date.now(),
  })
}

/**
 * Read the latest status for one server.
 * @param {string} server - MCP `serverName`.
 * @returns {{ phase: string, attempt: number, error: string | null, at: number } | undefined} status.
 */
export function readStatus(server) {
  return registry.get(server)
}

/**
 * Forget one server (the wrapper that owned it is gone).
 * @param {string} server - MCP `serverName`.
 */
export function clearStatus(server) {
  registry.delete(server)
}
