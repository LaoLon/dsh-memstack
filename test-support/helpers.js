import { Store } from '../lib/store.js'

/** Deterministic store: fixed clock that advances per call, sequential ids. */
export function makeStore(state) {
  let seq = 0
  let tick = 0
  return new Store(state, {
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
    id: (prefix) => `${prefix}_${++seq}`,
  })
}

export function seededRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function makeWorkspaceStore() {
  const store = makeStore()
  const { bankId } = store.ensureWorkspaceBank('ws-spdk', 'spdk-storage')
  return { store, bankId }
}
