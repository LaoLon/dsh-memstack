/** Read-side queries shared by the tools and the tests. Pure: no DSH imports. */

import { normalizeTopic } from './store.js'

export function visibleBanks(store) {
  return Object.values(store.state.banks).filter((bank) => !bank.archivedAt)
}

export function searchEntries(store, { query, bank, limit = 20 } = {}) {
  const needle = String(query ?? '').trim()
  const banks = visibleBanks(store).filter((item) => !bank || item.id === bank || item.title === bank)
  const cap = Math.min(50, Math.max(1, Math.trunc(Number(limit) || 20)))
  const results = []
  for (const item of banks) {
    for (const entry of store.listEntries(item.id, { status: 'active', q: needle })) {
      results.push({
        bankId: item.id,
        bankTitle: item.title,
        id: entry.id,
        topic: entry.topic,
        claim: entry.claim,
        kind: entry.kind,
        status: entry.status,
        updatedAt: entry.updatedAt,
      })
      if (results.length >= cap) return results
    }
  }
  return results
}

export function readEntry(store, { topic, id, bank } = {}) {
  if (id) {
    const entry = store.getEntry(id)
    return entry ? entryView(entry) : null
  }
  const entry = findActiveEntry(store, { topic, bank })
  return entry ? entryView(entry) : null
}

export function findActiveEntry(store, { topic, bank } = {}) {
  if (!topic) return null
  const needle = normalizeTopic(topic)
  const banks = visibleBanks(store).filter((item) => !bank || item.id === bank || item.title === bank)
  for (const item of banks) {
    const entry = store.findActive(item.id, needle)
    if (entry) return entry
  }
  return null
}

/** Every entry of the given banks, all statuses, for the management view. */export function inventory(store, { bankIds } = {}) {
  const banks = visibleBanks(store).filter((item) => !bankIds || bankIds.includes(item.id))
  const rows = []
  for (const bank of banks) {
    for (const entry of store.listEntries(bank.id)) {
      rows.push({
        bankId: bank.id,
        bankTitle: bank.title,
        topic: entry.topic,
        claim: entry.claim,
        kind: entry.kind,
        status: entry.status,
        updatedAt: entry.updatedAt,
      })
    }
  }
  return rows
}

/** Archive or delete one entry. Delete restores the predecessor it had replaced. */
export function forgetEntry(store, { topic, id, bank, mode = 'archive' } = {}) {
  const entry = id ? store.getEntry(id) : findActiveEntry(store, { topic, bank })
  if (!entry) return null
  const claim = entry.claim
  if (mode === 'delete') {
    const { restored } = store.deleteEntry(entry.id)
    return { result: 'deleted', topic: entry.topic, claim, restored: restored?.claim }
  }
  store.archiveEntry(entry.id)
  return { result: 'archived', topic: entry.topic, claim }
}

export function entryView(entry) {  return {
    topic: entry.topic,
    kind: entry.kind,
    claim: entry.claim,
    detail: entry.detail ?? '',
    confidence: entry.confidence,
    status: entry.status,
    updatedAt: entry.updatedAt,
  }
}
