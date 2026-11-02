/** Pure, dependency-free memory state machine. No DSH imports: unit-testable with `node --test`. */

export const ENTRY_KINDS = ['decision', 'constraint', 'gotcha', 'preference', 'open-question']
export const ENTRY_STATUSES = ['candidate', 'active', 'superseded', 'archived']
export const BANK_KINDS = ['workspace', 'topic', 'global']

const KIND_SET = new Set(ENTRY_KINDS)
const BANK_KIND_SET = new Set(BANK_KINDS)

export function emptyState() {
  return {
    schemaVersion: 1,
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

  static fromJSON(raw) {
    const state = raw && typeof raw === 'object' ? raw : emptyState()
    state.banks ??= {}
    state.entries ??= {}
    state.links ??= {}
    state.meta ??= { defaultBankByWorkspace: {}, inboxOrder: [] }
    state.meta.defaultBankByWorkspace ??= {}
    state.meta.inboxOrder ??= []
    state.schemaVersion ??= 1
    return new Store(state)
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
    for (const entry of Object.values(this.state.entries)) {
      if (entry.bankId === id) delete this.state.entries[entry.id]
    }
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
    const { bankId, kind = 'decision', claim, detail = '', rejected = [], confidence = 'verified', pin = false, source } = input
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
    if (previous && previous.claim === text && previous.kind === kind && sameValue(previous.detail ?? '', detail) && sameValue(previous.rejected ?? [], rejected)) {
      return { result: 'duplicate', entry: previous, previous: null }
    }

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
      recalledCount: 0,
      createdAt: this.now(),
      updatedAt: this.now(),
      source: source ? { sessionId: String(source.sessionId ?? ''), eventId: source.eventId ? String(source.eventId) : undefined } : undefined,
    }

    const previousSnapshot = previous ? clone(previous) : null
    if (previous) {
      previous.status = 'superseded'
      previous.supersededBy = entry.id
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
    if (patch.pinned !== undefined) entry.pinned = Boolean(patch.pinned)
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
    entry.updatedAt = this.now()
    return entry
  }

  archiveEntry(id) {
    const entry = this.state.entries[id]
    if (!entry) throw new Error(`entry-not-found:${id}`)
    entry.status = 'archived'
    entry.updatedAt = this.now()
    this.changes.push({ type: 'entry-archived', entry: clone(entry) })
    return entry
  }

  restoreEntry(id) {
    const entry = this.state.entries[id]
    if (!entry) throw new Error(`entry-not-found:${id}`)
    if (entry.status === 'active') return entry
    const conflicting = this.findActive(entry.bankId, entry.topic)
    if (conflicting && conflicting.id !== id) throw new Error(`topic-taken:${entry.topic}`)
    entry.status = 'active'
    delete entry.supersededBy
    entry.updatedAt = this.now()
    this.changes.push({ type: 'entry-restored', entry: clone(entry) })
    return entry
  }

  /** Hard delete. Keeps the supersede chain intact: the predecessor is re-linked or restored. */
  deleteEntry(id) {
    const entry = this.state.entries[id]
    if (!entry) throw new Error(`entry-not-found:${id}`)
    const predecessor = entry.supersedes ? this.state.entries[entry.supersedes] : null
    const successor = entry.supersededBy ? this.state.entries[entry.supersededBy] : null
    delete this.state.entries[id]

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
  return (entry.rejected ?? []).some((item) => item.option.toLowerCase().includes(needle))
}

function byPinThenRecency(a, b) {
  if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1
  return a.updatedAt < b.updatedAt ? 1 : -1
}
