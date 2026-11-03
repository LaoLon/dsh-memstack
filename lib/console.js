/** Supervises the local console process: one per Host, spawned on demand, stopped with the plugin. */

import { spawn as nodeSpawn } from 'node:child_process'

export async function isConsoleAlive(port, timeoutMs = 600) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/state`, { signal: AbortSignal.timeout(timeoutMs) })
    return response.ok
  } catch {
    return false
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * @param {object} options
 * @param {boolean} options.enabled   - start nothing when false
 * @param {number} options.port
 * @param {string} options.scriptPath - absolute path to console/server.mjs
 * @param {object} [options.logger]
 * @param {Function} [options.spawn]  - injectable for tests
 * @param {Function} [options.alive]  - injectable for tests
 * @param {number} [options.pollIntervalMs]
 * @param {number} [options.attempts]
 */
export function createConsoleSupervisor(options) {
  const {
    enabled,
    port,
    scriptPath,
    logger,
    spawn = nodeSpawn,
    alive = isConsoleAlive,
    pollIntervalMs = 150,
    attempts = 20,
  } = options

  let child = null
  let disposed = false
  let owned = false

  const start = async () => {
    if (!enabled || disposed) return false
    if (await alive(port)) {
      logger?.info?.('memstack: console already listening on port %d', port)
      return false
    }
    try {
      child = spawn(process.execPath, [scriptPath], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', MEMSTACK_CONSOLE_PORT: String(port) },
        stdio: 'ignore',
        windowsHide: true,
      })
      // The console is a sibling service, not a reason for the Host process to stay alive.
      child.unref?.()
      owned = true
      child.on?.('exit', () => {
        child = null
      })
    } catch (error) {
      logger?.warn?.('memstack: console failed to spawn: %o', error)
      return false
    }

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await delay(pollIntervalMs)
      if (disposed || !child) return false
      if (await alive(port)) {
        logger?.info?.('memstack: console started on http://127.0.0.1:%d', port)
        return true
      }
    }
    logger?.warn?.('memstack: console did not become ready on port %d', port)
    return false
  }

  const stop = () => {
    disposed = true
    if (!child || !owned) return
    try {
      child.kill()
    } catch {
      // The process already exited.
    }
    child = null
  }

  return {
    start,
    stop,
    get child() {
      return child
    },
    get owned() {
      return owned
    },
  }
}
