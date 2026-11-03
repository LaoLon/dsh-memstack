/** Pure, dependency-free memory state machine. No DSH imports: unit-testable with `node --test`. */

import {
  clampStability,
  initialStability,
  PINNED_FACTOR,
  recallPatch,
  reviewPatch,
} from './decay.js'

export const ENTRY_KINDS = ['decision', 'constraint', 'gotcha', 'preference', 'open-question']
export const ENTRY_STATUSES = ['candidate', 'active', 'superseded', 'archived']
export const BANK_KINDS = ['workspace', 'topic', 'global']
export const RELATION_TYPES = ['related', 'refines', 'depends', 'contradicts']
export const SCHEMA_VERSION = 2
export const TAG_LIMIT = 8
export const TAG_MAX_LENGTH = 32

const KIND_SET = new Set(ENTRY_KINDS)
const BANK_KIND_SET = new Set(BANK_KINDS)
const RELATION_SET = new Set(RELATION_TYPES)

export function emptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    banks: {},
    entries: {},
    links: {},
    meta: { defaultBankByWorkspace: {}, inboxOrder: [] },
  }
}

/** Stable, human-readable topic key. Keeps CJK and digits; collapses separators. */
export function normalizeTopic(topic) {
  return String(topic ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_/\\]+/gu, '-')
    .replace(/[^\p{L}\p{N}.-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
}

/** Tags are lowercase, separator-normalized, de-duplicated and capped. */
export function normalizeTags(input) {
  const list = Array.isArray(input) ? input : String(input ?? '').split(/[,，;；\n]/)
  const tags = []
  for (const raw of list) {
    const tag = String(raw ?? '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^\p{L}\p{N}._:/-]+/gu, '')
      .slice(0, TAG_MAX_LENGTH)
    if (!tag || tags.includes(tag)) continue
    tags.push(tag)
    if (tags.length >= TAG_LIMIT) break
  }
  return tags
}

export function normalizeRelations(input, selfId) {
  if (!Array.isArray(input)) return []
  const relations = []
  const seen = new Set()
  for (const raw of input) {
    const target = String(raw?.target ?? raw?.to ?? '').trim()
    const type = String(raw?.type ?? 'related').trim()
    if (!target || target === selfId) continue
    if (!RELATION_SET.has(type)) continue
    if (seen.has(target)) continue
    seen.add(target)
    const relation = { target, type }
    const note = String(raw?.note ?? '').trim()
    if (note) relation.note = note.slice(0, 500)
    relations.push(relation)
    if (relations.length >= 24) break
  }
  return relations
}

function clone(value) {
  return value == null ? value : structuredClone(value)
}

function defaultId() {
  return Math.random().toString(36).slice(2, 10)
}

export function linkKey(fromBankId, toBankId) {
  return `${fromBankId}->${toBankId}`
}

export class Store {
  constructor(state, options = {}) {
    this.state = state ?? emptyState()
    this.now = options.now ?? (() => new Date().toISOString())
    this.id = options.id ?? ((prefix) => `${prefix}_${defaultId()}`)
    this.changes = []
  }

  /** Loads persisted state, filling defaults and migrating v1 entries in place. */
  static fromJSON(raw, options = {}) {
    const state = raw && typeof raw === 'object' ? raw : emptyState()
    state.banks ??= {}
    state.entries ??= {}
    state.links ??= {}
    state.meta ??= { defaultBankByWorkspace: {}, inboxOrder: [] }
    state.meta.defaultBankByWorkspace ??= {}
    state.meta.inboxOrder ??= []
    const store = new Store(state, options)
    store.migrate()
    return store
  }

  /** Idempotent normalization: safe to run on every load and after an import. */
  migrate() {
    const timestamp = this.now()
    this.state.schemaVersion = SCHEMA_VERSION
    for (const bank of Object.values(this.state.banks)) {
      bank.title = String(bank.title ?? 'Untitled')
      bank.kind = BANK_KIND_SET.has(bank.kind) ? bank.kind : 'topic'
      bank.description = String(bank.description ?? '')
      bank.workspaceIds = Array.isArray(bank.workspaceIds) ? bank.workspaceIds : []
      bank.createdAt ??= timestamp
      bank.updatedAt ??= bank.createdAt
    }
    for (const entry of Object.values(this.state.entries)) this.migrateEntry(entry, timestamp)
    const ids = new Set(Object.keys(this.state.entries))
    for (const entry of Object.values(this.state.entries)) {
      entry.relations = entry.relations.filter((relation) => relation.target !== entry.id && ids.has(relation.target))
    }
    for (const [key, link] of Object.entries(this.state.links)) {
      if (!this.state.banks[link.fromBankId] || !this.state.banks[link.toBankId]) delete this.state.links[key]
    }
  }

  migrateEntry(entry, timestamp) {
    entry.id = String(entry.id)
    entry.topic = normalizeTopic(entry.topic)
    entry.kind = KIND_SET.has(entry.kind) ? entry.kind : 'decision'
    entry.claim = String(entry.claim ?? '').trim()
    entry.detail = String(entry.detail ?? '')
    entry.status = ENTRY_STATUSES.includes(entry.status) ? entry.status : 'active'
    entry.confidence = entry.confidence === 'tentative' ? 'tentative' : 'verified'
    entry.pinned = Boolean(entry.pinned)
    entry.tags = normalizeTags(entry.tags)
    entry.relations = normalizeRelations(entry.relations, entry.id)
    entry.rejected = Array.isArray(entry.rejected)
      ? entry.rejected.map((item) => ({ option: String(item?.option ?? ''), reason: String(item?.reason ?? '') }))
      : []
    entry.createdAt ??= timestamp
    entry.updatedAt ??= entry.createdAt
    entry.recalledCount = Number.isFinite(Number(entry.recalledCount)) ? Number(entry.recalledCount) : 0
    entry.reviewCount = Number.isFinite(Number(entry.reviewCount)) ? Number(entry.reviewCount) : 0
    entry.stabilityDays = clampStability(
      entry.stabilityDays ?? initialStability({ kind: entry.kind, confidence: entry.confidence, pinned: entry.pinned }),
    )
    // v1 entries never had a review timestamp: the conclusion was last confirmed when it was written.
    entry.lastReviewedAt ??= entry.createdAt
    if (entry.status === 'superseded' && !entry.supersededAt) entry.supersededAt = entry.updatedAt
    if (entry.status === 'archived' && !entry.archivedAt) entry.archivedAt = entry.updatedAt
    return entry
  }

  toJSON() {
    return clone(this.state)
  }

  takeChanges() {
    const changes = this.changes
    this.changes = []
    return changes
  }

  // ---------------------------------------------------------------- banks

  createBank({ kind = 'topic', title, description = '', workspaceIds = [] } = {}) {
    if (!BANK_KIND_SET.has(kind)) throw new Error(`unknown-bank-kind:${kind}`)
    const id = this.id('bank')
    const timestamp = this.now()
    const bank = {
      id,
      title: String(title ?? '').trim() || 'Untitled',
      kind,
      description: String(description ?? ''),
      workspaceIds: [...workspaceIds],
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    this.state.banks[id] = bank
    return bank
  }

  /** Lazily create the single workspace bank. Returns a stable bankId for the workspace. */
  ensureWorkspaceBank(workspaceId, title) {
    const key = String(workspaceId || 'default')
    const existingId = this.state.meta.defaultBankByWorkspace[key]
    const existing = existingId ? this.state.banks[existingId] : null
    if (existing && !existing.archivedAt) return { bankId: existing.id, created: false }
    const bank = this.createBank({
      kind: 'workspace',
      title: title ?? key,
      workspaceIds: key === 'default' ? [] : [key],
    })
    this.state.meta.defaultBankByWorkspace[key] = bank.id
    return { bankId: bank.id, created: true }
  }

  updateBank(id, patch = {}) {
    const bank = this.state.banks[id]
    if (!bank) throw new Error(`bank-not-found:${id}`)
    for (const field of ['title', 'description']) {
      if (patch[field] !== undefined) bank[field] = String(patch[field])
    }
    if (patch.exportEnabled !== undefined) bank.exportEnabled = Boolean(patch.exportEnabled)
    if (patch.workspaceIds !== undefined) bank.workspaceIds = [...patch.workspaceIds]
    bank.updatedAt = this.now()
    return bank
  }

  archiveBank(id) {
    const bank = this.state.banks[id]
    if (!bank) throw new Error(`bank-not-found:${id}`)
    if (bank.archivedAt) return bank
    bank.archivedAt = this.now()
    bank.updatedAt = bank.archivedAt
    this.changes.push({ type: 'bank-archived', bankId: id, title: bank.title })
    return bank
  }

  restoreBank(id) {
    const bank = this.state.banks[id]
    if (!bank) throw new Error(`bank-not-found:${id}`)
    delete bank.archivedAt
    bank.updatedAt = this.now()
    return bank
  }

  deleteBank(id) {
    const bank = this.state.banks[id]
    if (!bank) throw new Error(`bank-not-found:${id}`)
    const removed = new Set()
    for (const entry of Object.values(this.state.entries)) {
      if (entry.bankId === id) {
        removed.add(entry.id)
        delete this.state.entries[entry.id]
      }
    }
    this.pruneRelations(removed)
    for (const [key, link] of Object.entries(this.state.links)) {
      if (link.fromBankId === id || link.toBankId === id) delete this.state.links[key]
    }
    for (const [workspaceId, bankId] of Object.entries(this.state.meta.defaultBankByWorkspace ?? {})) {
      if (bankId === id) delete this.state.meta.defaultBankByWorkspace[workspaceId]
    }
    delete this.state.banks[id]
    this.changes.push({ type: 'bank-deleted', bankId: id, title: bank.title })
    return bank
  }

  listBanks({ includeArchived = false } = {}) {
    return Object.values(this.state.banks)
      .filter((bank) => includeArchived || !bank.archivedAt)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }

  // -------------------------------------------------------------- entries

  findActive(bankId, topic) {
    for (const entry of Object.values(this.state.entries)) {
      if (entry.bankId === bankId && entry.topic === topic && entry.status === 'active') return entry
    }
    return null
  }

  getEntry(id) {
    return this.state.entries[id] ?? null
  }

  writeEntry(input = {}) {
    const {
      bankId,
      kind = 'decision',
      claim,
      detail = '',
      rejected = [],
      confidence = 'verified',
      pin = false,
      tags = [],
      relations = [],
      source,
      stabilityDays,
    } = input
    const bank = this.state.banks[bankId]
    if (!bank) throw new Error(`bank-not-found:${bankId}`)
    if (bank.archivedAt) throw new Error(`bank-archived:${bankId}`)
    if (!KIND_SET.has(kind)) throw new Error(`unknown-kind:${kind}`)
    const topic = normalizeTopic(input.topic)
    if (!topic) throw new Error('empty-topic')
    const text = String(claim ?? '').trim()
    if (!text) throw new Error('empty-claim')
    if (confidence !== 'verified' && confidence !== 'tentative') throw new Error(`unknown-confidence:${confidence}`)

    const previous = this.findActive(bankId, topic)
    if (
      previous &&
      previous.claim === text &&
      previous.kind === kind &&
      sameValue(previous.detail ?? '', detail) &&
      sameValue(previous.rejected ?? [], rejected)
    ) {
      return { result: 'duplicate', entry: previous, previous: null }
    }

    const timestamp = this.now()
    const entry = {
      id: this.id('entry'),
      bankId,
      topic,
      kind,
      claim: text,
      detail: String(detail ?? ''),
      rejected: rejected.map((item) => ({ option: String(item.option ?? ''), reason: String(item.reason ?? '') })),
      status: 'active',
      confidence,
      pinned: Boolean(pin),
      tags: normalizeTags(tags),
      relations: normalizeRelations(relations, ''),
      recalledCount: 0,
      reviewCount: 0,
      stabilityDays: clampStability(
        stabilityDays ?? initialStability({ kind, confidence, pinned: Boolean(pin) }),
      ),
      lastReviewedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
      source: source
        ? { sessionId: String(source.sessionId ?? ''), eventId: source.eventId ? String(source.eventId) : undefined }
        : undefined,
    }
    entry.relations = normalizeRelations(entry.relations, entry.id)

    const previousSnapshot = previous ? clone(previous) : null
    if (previous) {
      previous.status = 'superseded'
      previous.supersededBy = entry.id
      previous.supersededAt = entry.createdAt
      previous.updatedAt = entry.updatedAt
      entry.supersedes = previous.id
    }

    this.state.entries[entry.id] = entry
    this.changes.push({
      type: previous ? 'entry-updated' : 'entry-created',
      entry: clone(entry),
      previous: previousSnapshot,
    })
    return { result: previous ? 'superseded' : 'created', entry, previous: previousSnapshot }
  }

  updateEntry(id, patch = {}) {
    const entry = this.state.entries[id]
    if (!entry) throw new Error(`entry-not-found:${id}`)
    if (patch.claim !== undefined) entry.claim = String(patch.claim).trim() || entry.claim
    if (patch.detail !== undefined) entry.detail = String(patch.detail)
    if (patch.kind !== undefined) {
      if (!KIND_SET.has(patch.kind)) throw new Error(`unknown-kind:${patch.kind}`)
      entry.kind = patch.kind
    }
    if (patch.confidence !== undefined) entry.confidence = patch.confidence
    if (patch.tags !== undefined) entry.tags = normalizeTags(patch.tags)
    if (patch.rejected !== undefined) {
      entry.rejected = patch.rejected.map((item) => ({ option: String(item.option ?? ''), reason: String(item.reason ?? '') }))
    }
    if (patch.topic !== undefined) {
      const topic = normalizeTopic(patch.topic)
      if (!topic) throw new Error('empty-topic')
      const conflicting = this.findActive(entry.bankId, topic)
      if (conflicting && conflicting.id !== id) throw new Error(`topic-taken:${topic}`)
      entry.topic = topic
    }
    if (patch.pinned !== undefined) {
      const next = Boolean(patch.pinned)
      if (next && !entry.pinned) {
        // Pinning is a commitment: make sure the entry starts at the pinned half-life.
        const floor = initialStability({ kind: entry.kind, confidence: entry.confidence, pinned: true })
        entry.stabilityDays = clampStability(Math.max(entry.stabilityDays, floor))
      }
      entry.pinned = next
    }
    entry.updatedAt = this.now()
    return entry
  }

  archiveEntry(id) {
    const entry = this.state.entries[id]
    if (!entry) throw new Error(`entry-not-found:${id}`)
    if (entry.status === 'archived') return entry
    entry.archivedFrom = entry.status
    entry.status = 'archived'
    entry.archivedAt = this.now()
    entry.updatedAt = entry.archivedAt
    this.changes.push({ type: 'entry-archived', entry: clone(entry) })
    return entry
  }

  restoreEntry(id) {
    const entry = this.state.entries[id]
    if (!entry) throw new Error(`entry-not-found:${id}`)
    if (entry.status === 'active') return entry
    if (entry.status === 'superseded' || entry.archivedFrom === 'superseded') {
      throw new Error(`superseded-cannot-restore:${id}`)
    }
    const conflicting = this.findActive(entry.bankId, entry.topic)
    if (conflicting && conflicting.id !== id) throw new Error(`topic-taken:${entry.topic}`)
    entry.status = 'active'
    delete entry.supersededBy
    delete entry.archivedAt
    delete entry.archivedFrom
    entry.updatedAt = this.now()
    this.changes.push({ type: 'entry-restored', entry: clone(entry) })
    return entry
  }

  /** Confirms a memory is still true: the spaced-repetition "successful recall". */
  reviewEntry(id) {
    const entry = this.state.entries[id]
    if (!entry) throw new Error(`entry-not-found:${id}`)
    Object.assign(entry, reviewPatch(entry, this.now()))
    this.changes.push({ type: 'entry-reviewed', entry: clone(entry) })
    return entry
  }

  /** Marks entries as surfaced. Used once per injected index; does not emit a change notice. */
  reinforce(ids = []) {
    const timestamp = this.now()
    let count = 0
    for (const id of ids) {
      const entry = this.state.entries[id]
      if (!entry || entry.status !== 'active') continue
      Object.assign(entry, recallPatch(entry, timestamp))
      count += 1
    }
    return count
  }

  relate(fromId, toId, type = 'related', note = '') {
    const from = this.state.entries[fromId]
    const to = this.state.entries[toId]
    if (!from) throw new Error(`entry-not-found:${fromId}`)
    if (!to) throw new Error(`entry-not-found:${toId}`)
    if (fromId === toId) throw new Error('self-relation')
    if (!RELATION_SET.has(type)) throw new Error(`unknown-relation-type:${type}`)
    const existing = from.relations.find((relation) => relation.target === toId)
    if (existing) {
      existing.type = type
      existing.note = String(note ?? '').slice(0, 500)
      return existing
    }
    const relation = { target: toId, type }
    const trimmed = String(note ?? '').trim()
    if (trimmed) relation.note = trimmed.slice(0, 500)
    from.relations.push(relation)
    this.changes.push({ type: 'entry-related', entry: clone(from), relation: clone(relation) })
    return relation
  }

  unrelate(fromId, toId) {
    const from = this.state.entries[fromId]
    if (!from) throw new Error(`entry-not-found:${fromId}`)
    const before = from.relations.length
    from.relations = from.relations.filter((relation) => relation.target !== toId)
    return from.relations.length !== before
  }

  /** Removes every relation that points at a deleted entry. */
  pruneRelations(removedIds) {
    if (!removedIds?.size) return
    for (const entry of Object.values(this.state.entries)) {
      entry.relations = (entry.relations ?? []).filter((relation) => !removedIds.has(relation.target))
    }
  }

  /** Hard delete. Keeps the supersede chain intact: the predecessor is re-linked or restored. */
  deleteEntry(id) {
    const entry = this.state.entries[id]
    if (!entry) throw new Error(`entry-not-found:${id}`)
    const predecessor = entry.supersedes ? this.state.entries[entry.supersedes] : null
    const successor = entry.supersededBy ? this.state.entries[entry.supersededBy] : null
    delete this.state.entries[id]
    this.pruneRelations(new Set([id]))

    let restored = null
    if (successor && successor.supersedes === id) {
      if (predecessor && predecessor.supersededBy === id) {
        // Middle of a chain: splice it out so the chain stays connected.
        predecessor.supersededBy = successor.id
        successor.supersedes = predecessor.id
      } else {
        delete successor.supersedes
      }
    }

    if (predecessor && predecessor.supersededBy === id) {
      const conflicting = this.findActive(entry.bankId, entry.topic)
      if (predecessor.status === 'superseded' && !conflicting) {
        predecessor.status = 'active'
        delete predecessor.supersededBy
        delete predecessor.supersededAt
        predecessor.updatedAt = this.now()
        restored = predecessor
      } else {
        delete predecessor.supersededBy
      }
    }

    this.changes.push({
      type: 'entry-deleted',
      entryId: id,
      bankId: entry.bankId,
      topic: entry.topic,
      claim: entry.claim,
      restoredId: restored?.id,
    })
    return { entry, restored }
  }

  listEntries(bankId, { status, kind, q, includeSuperseded = true } = {}) {
    const needle = q ? String(q).toLowerCase() : ''
    return Object.values(this.state.entries)
      .filter((entry) => (bankId ? entry.bankId === bankId : true))
      .filter((entry) => (status ? entry.status === status : includeSuperseded ? true : entry.status === 'active'))
      .filter((entry) => (kind ? entry.kind === kind : true))
      .filter((entry) => (needle ? matches(entry, needle) : true))
      .sort(byPinThenRecency)
  }

  // ---------------------------------------------------------------- links

  link(fromBankId, toBankId, { recall = false, query = true } = {}) {
    if (!this.state.banks[fromBankId]) throw new Error(`bank-not-found:${fromBankId}`)
    if (!this.state.banks[toBankId]) throw new Error(`bank-not-found:${toBankId}`)
    if (fromBankId === toBankId) throw new Error('self-link')
    const link = { fromBankId, toBankId, recall: Boolean(recall), query: Boolean(query) }
    this.state.links[linkKey(fromBankId, toBankId)] = link
    return link
  }

  unlink(fromBankId, toBankId) {
    delete this.state.links[linkKey(fromBankId, toBankId)]
  }

  linksFrom(bankId) {
    return Object.values(this.state.links).filter((link) => link.fromBankId === bankId)
  }

  // ------------------------------------------------------------ integrity

  /** Reports invariant violations; tests call this after arbitrary operation sequences. */
  assertInvariants() {
    const problems = []
    const activeByTopic = new Map()
    const entries = Object.values(this.state.entries)
    const ids = new Set(Object.keys(this.state.entries))

    for (const entry of entries) {
      if (!this.state.banks[entry.bankId]) problems.push(`orphan-entry:${entry.id}`)
      if (entry.status === 'active') {
        const key = `${entry.bankId}::${entry.topic}`
        if (activeByTopic.has(key)) problems.push(`duplicate-active:${key}`)
        activeByTopic.set(key, entry.id)
      }
      if (entry.supersedes) {
        const predecessor = this.state.entries[entry.supersedes]
        if (!predecessor) problems.push(`dangling-supersedes:${entry.id}`)
        else if (predecessor.supersededBy !== entry.id) problems.push(`asymmetric-supersedes:${entry.id}`)
      }
      if (entry.supersededBy) {
        const successor = this.state.entries[entry.supersededBy]
        if (!successor) problems.push(`dangling-superseded-by:${entry.id}`)
        else if (successor.supersedes !== entry.id) problems.push(`asymmetric-superseded-by:${entry.id}`)
      }
      const stability = Number(entry.stabilityDays)
      if (!Number.isFinite(stability) || stability < 0.5 || stability > 730) {
        problems.push(`bad-stability:${entry.id}`)
      }
      for (const relation of entry.relations ?? []) {
        if (!RELATION_SET.has(relation.type)) problems.push(`bad-relation-type:${entry.id}`)
        if (relation.target === entry.id) problems.push(`self-relation:${entry.id}`)
        else if (!ids.has(relation.target)) problems.push(`dangling-relation:${entry.id}`)
      }
    }

    for (const entry of entries) {
      const seen = new Set()
      let cursor = entry
      while (cursor?.supersedes) {
        if (seen.has(cursor.id)) {
          problems.push(`supersede-cycle:${entry.id}`)
          break
        }
        seen.add(cursor.id)
        cursor = this.state.entries[cursor.supersedes]
      }
    }

    return problems
  }
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}

function matches(entry, needle) {
  if (entry.topic.includes(needle)) return true
  if (entry.claim.toLowerCase().includes(needle)) return true
  if ((entry.detail ?? '').toLowerCase().includes(needle)) return true
  if ((entry.tags ?? []).some((tag) => tag.includes(needle))) return true
  return (entry.rejected ?? []).some((item) => item.option.toLowerCase().includes(needle))
}

function byPinThenRecency(a, b) {
  if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1
  return a.updatedAt < b.updatedAt ? 1 : -1
}
