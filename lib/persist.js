/** Durable JSON store under $DSH_HOME/memstack. Atomic replace; one write chain. */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export function resolveHomeDir(env = process.env) {
  return env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

export function statePath(homeDir) {
  return join(homeDir, 'memstack', 'state.json')
}

let chain = Promise.resolve()

/** Serializes writes: a failed write rejects this caller without poisoning later ones. */
export function saveState(path, state) {
  const run = chain.then(() => writeAtomic(path, state))
  chain = run.catch(() => {})
  return run
}

async function writeAtomic(path, state) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8')
  await rename(temporary, path)
}

export async function loadState(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}
