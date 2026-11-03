/** Read-side queries shared by the tools, the console API and the tests. Pure: no DSH imports. */

import { describeDecay, retentionOf, scoreOf } from './decay.js'
import { normalizeTopic } from './store.js'

export function visibleBanks(store) {
  return Object.values(store.state.banks).filter((bank) => !bank.archivedAt)
}

export function searchEntries(store, { query, bank, limit = 20, now = new Date() } = {}) {
  const needle = String(query ?? '').trim().toLowerCase()
  const banks = visibleBanks(store).filter((item) => !bank || item.id === bank || item.title === bank)
  const cap = Math.min(50, Math.max(1, Math.trunc(Number(limit) || 20)))
  const ranked = []
  for (const item of banks) {
    for (const entry of store.listEntries(item.id, { status: 'active', q: needle })) {
      ranked.push({ entry, bank: item, relevance: relevanceOf(entry, needle) })
    }
  }
  ranked.sort((a, b) => {
    if (a.relevance !== b.relevance) return b.relevance - a.relevance
    const scoreA = scoreOf(a.entry, now)
    const scoreB = scoreOf(b.entry, now)
    if (scoreA !== scoreB) return scoreB - scoreA
    return a.entry.updatedAt < b.entry.updatedAt ? 1 : -1
  })
  return ranked.slice(0, cap).map(({ entry, bank: item }) => {
    const decay = describeDecay(entry, now)
    return {
      bankId: item.id,
      bankTitle: item.title,
      id: entry.id,
      topic: entry.topic,
      claim: entry.claim,
      kind: entry.kind,
      status: entry.status,
      tags: entry.tags ?? [],
      pinned: Boolean(entry.pinned),
      retention: decay.retention,
      stage: decay.stage,
      stale: decay.retention < 0.5,
      updatedAt: entry.updatedAt,
    }
  })
}

function relevanceOf(entry, needle) {
  if (!needle) return 0
  let relevance = 0
  if (entry.topic === needle) relevance += 5
  else if (entry.topic.includes(needle)) relevance += 3
  if (entry.claim.toLowerCase().includes(needle)) relevance += 2
  if ((entry.tags ?? []).some((tag) => tag.includes(needle))) relevance += 1.5
  if ((entry.detail ?? '').toLowerCase().includes(needle)) relevance += 0.8
  if ((entry.rejected ?? []).some((item) => item.option.toLowerCase().includes(needle))) relevance += 0.6
  return relevance
}

/** Resolves one entry by id first, then by topic (active first, then any status). */
export function resolveEntry(store, { topic, id, bank, includeInactive = false } = {}) {
  if (id) return store.getEntry(id)
  if (!topic) return null
  const needle = normalizeTopic(topic)
  const banks = visibleBanks(store).filter((item) => !bank || item.id === bank || item.title === bank)
  for (const item of banks) {
    const entry = store.findActive(item.id, needle)
    if (entry) return entry
  }
  if (!includeInactive) return null
  for (const item of banks) {
    const found = store
      .listEntries(item.id, { status: undefined, q: needle })
      .find((entry) => entry.topic === needle)
    if (found) return found
  }
  return null
}

export function readEntry(store, args = {}, now = new Date()) {
  const entry = resolveEntry(store, args)
  return entry ? entryView(store, entry, now) : null
}

export function entryView(store, entry, now = new Date()) {
  const decay = describeDecay(entry, now)
  const bank = store.state.banks[entry.bankId]
  const reference = (other) => (other ? { id: other.id, topic: other.topic, claim: other.claim, status: other.status } : null)
  const outgoing = (entry.relations ?? [])
    .map((relation) => {
      const target = store.state.entries[relation.target]
      if (!target) return null
      return { type: relation.type, note: relation.note ?? '', target: reference(target) }
    })
    .filter(Boolean)
  const incoming = []
  for (const other of Object.values(store.state.entries)) {
    for (const relation of other.relations ?? []) {
      if (relation.target !== entry.id) continue
      incoming.push({ type: relation.type, note: relation.note ?? '', source: reference(other) })
    }
  }
  return {
    id: entry.id,
    bankId: entry.bankId,
    bankTitle: bank?.title ?? entry.bankId,
    topic: entry.topic,
    kind: entry.kind,
    claim: entry.claim,
    detail: entry.detail ?? '',
    rejected: entry.rejected ?? [],
    tags: entry.tags ?? [],
    confidence: entry.confidence,
    status: entry.status,
    pinned: Boolean(entry.pinned),
    source: entry.source ?? null,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    recalledCount: entry.recalledCount ?? 0,
    reviewCount: entry.reviewCount ?? 0,
    lastReviewedAt: entry.lastReviewedAt ?? entry.createdAt ?? null,
    lastRecalledAt: entry.lastRecalledAt ?? null,
    retention: decay.retention,
    stage: decay.stage,
    stabilityDays: decay.stabilityDays,
    ageDays: decay.ageDays,
    nextReviewAt: decay.nextReviewAt,
    decay,
    supersedes: entry.supersedes ? reference(store.state.entries[entry.supersedes]) : null,
    supersededBy: entry.supersededBy ? reference(store.state.entries[entry.supersededBy]) : null,
    relations: outgoing,
    incomingRelations: incoming,
    chain: supersedeChain(store, entry),
  }
}

/** Full supersede history, oldest first. */
export function supersedeChain(store, entry) {
  const chain = []
  const seen = new Set()
  let cursor = entry
  while (cursor) {
    if (seen.has(cursor.id)) break
    seen.add(cursor.id)
    chain.push({ id: cursor.id, topic: cursor.topic, claim: cursor.claim, status: cursor.status, updatedAt: cursor.updatedAt })
    cursor = cursor.supersedes ? store.state.entries[cursor.supersedes] : null
  }
  chain.reverse()
  cursor = entry.supersededBy ? store.state.entries[entry.supersededBy] : null
  while (cursor) {
    if (seen.has(cursor.id)) break
    seen.add(cursor.id)
    chain.push({ id: cursor.id, topic: cursor.topic, claim: cursor.claim, status: cursor.status, updatedAt: cursor.updatedAt })
    cursor = cursor.supersededBy ? store.state.entries[cursor.supersededBy] : null
  }
  return chain
}

/** Every entry of the given banks, all statuses, for the management view. */
export function inventory(store, { bankIds, now = new Date() } = {}) {
  const banks = visibleBanks(store).filter((item) => !bankIds || bankIds.includes(item.id))
  const rows = []
  for (const bank of banks) {
    for (const entry of store.listEntries(bank.id)) {
      const decay = describeDecay(entry, now)
      rows.push({
        id: entry.id,
        bankId: bank.id,
        bankTitle: bank.title,
        topic: entry.topic,
        claim: entry.claim,
        kind: entry.kind,
        status: entry.status,
        tags: entry.tags ?? [],
        pinned: Boolean(entry.pinned),
        retention: decay.retention,
        stage: decay.stage,
        stabilityDays: decay.stabilityDays,
        updatedAt: entry.updatedAt,
      })
    }
  }
  return rows
}

/** Archive or delete one entry. Delete restores the predecessor it had replaced. */
export function forgetEntry(store, { topic, id, bank, mode = 'archive' } = {}) {
  const entry = resolveEntry(store, { topic, id, bank, includeInactive: mode === 'delete' })
  if (!entry) return null
  const claim = entry.claim
  if (mode === 'delete') {
    const { restored } = store.deleteEntry(entry.id)
    return { result: 'deleted', id: entry.id, topic: entry.topic, claim, restored: restored?.claim }
  }
  if (entry.status === 'archived') return null
  store.archiveEntry(entry.id)
  return { result: 'archived', id: entry.id, topic: entry.topic, claim }
}

/** Entries worth re-reading: low retention, still active. */
export function reviewQueue(store, { now = new Date(), limit = 20 } = {}) {
  return Object.values(store.state.entries)
    .filter((entry) => entry.status === 'active')
    .map((entry) => ({ entry, retention: retentionOf(entry, now) }))
    .sort((a, b) => a.retention - b.retention)
    .slice(0, limit)
    .map(({ entry, retention }) => ({
      id: entry.id,
      topic: entry.topic,
      claim: entry.claim,
      bankId: entry.bankId,
      retention: Number(retention.toFixed(3)),
      stabilityDays: Number(Number(entry.stabilityDays).toFixed(1)),
      lastReviewedAt: entry.lastReviewedAt,
      pinned: Boolean(entry.pinned),
    }))
}
