/**
 * Cross-machine portability: versioned JSON bundle, merge/replace import with
 * id remapping, and a Markdown projection for git-friendly backups.
 *
 * Pure apart from {@link buildBundle}'s caller-supplied metadata. Import mutates
 * the Store through its state object but always leaves invariants intact:
 * dangling or asymmetric supersede/relation links created by remapping are
 * repaired at the end and reported.
 */

import { emptyState, SCHEMA_VERSION, Store } from './store.js'
import { APP_VERSION } from './version.js'

export const BUNDLE_FORMAT = 'memstack.bundle'
export const BUNDLE_VERSION = SCHEMA_VERSION
export const MERGE_MODES = ['merge', 'replace']

function clone(value) {
  return value == null ? value : structuredClone(value)
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now())
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

function countOf(value) {
  return Object.keys(value ?? {}).length
}

export function bundleStats(state) {
  const entries = Object.values(state?.entries ?? {})
  return {
    banks: countOf(state?.banks),
    entries: entries.length,
    active: entries.filter((entry) => entry.status === 'active').length,
    superseded: entries.filter((entry) => entry.status === 'superseded').length,
    archived: entries.filter((entry) => entry.status === 'archived').length,
    links: countOf(state?.links),
  }
}

/** Full-fidelity export: history is part of the value of a memory, so nothing is filtered out. */
export function buildBundle(state, options = {}) {
  const {
    now = new Date(),
    appVersion = APP_VERSION,
    machine = '',
    platform = '',
    dshHome = '',
  } = options
  const snapshot = clone(state ?? emptyState())
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: iso(now),
    app: { name: '@local/memstack', version: appVersion },
    source: { machine, platform, dshHome },
    stats: bundleStats(snapshot),
    state: snapshot,
  }
}

export function serializeBundle(bundle) {
  return `${JSON.stringify(bundle, null, 2)}\n`
}

/** Validates and normalizes an uploaded bundle. Throws `bad-bundle:*` on bad input. */
export function parseBundle(input, options = {}) {
  let value = input
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input)
    } catch {
      throw new Error('bad-bundle:invalid-json')
    }
  }
  if (!value || typeof value !== 'object') throw new Error('bad-bundle:not-an-object')

  // Bare state.json is accepted as a legacy bundle, but never confused with a foreign format.
  const legacy = Boolean(!value.format && value.banks && value.entries)
  if (!legacy && value.format !== BUNDLE_FORMAT) throw new Error('bad-bundle:format')
  const version = Number(value.version ?? value.state?.schemaVersion ?? SCHEMA_VERSION)
  if (!Number.isFinite(version) || version < 1 || version > BUNDLE_VERSION) {
    throw new Error(`bad-bundle:version:${value.version}`)
  }
  const rawState = value.state ?? value
  if (!rawState || typeof rawState !== 'object' || !rawState.banks || !rawState.entries) {
    throw new Error('bad-bundle:state')
  }

  const store = Store.fromJSON(clone(rawState), { now: () => iso(options.now) })
  for (const entry of Object.values(store.state.entries)) {
    if (!entry.claim) throw new Error(`bad-bundle:empty-claim:${entry.id}`)
  }

  return {
    format: BUNDLE_FORMAT,
    version,
    exportedAt: value.exportedAt ?? null,
    app: value.app ?? null,
    source: value.source ?? null,
    stats: bundleStats(store.state),
    state: store.toJSON(),
    legacy,
  }
}

function sameCore(a, b) {
  return (
    a.topic === b.topic &&
    a.claim === b.claim &&
    a.kind === b.kind &&
    (a.detail ?? '') === (b.detail ?? '') &&
    JSON.stringify(a.rejected ?? []) === JSON.stringify(b.rejected ?? [])
  )
}

function findActiveLocal(state, bankId, topic) {
  for (const entry of Object.values(state.entries)) {
    if (entry.bankId === bankId && entry.topic === topic && entry.status === 'active') return entry
  }
  return null
}

function freshId(store, prefix = 'entry') {
  let id = store.id(prefix)
  while (store.state.entries[id] || store.state.banks[id]) id = store.id(prefix)
  return id
}

function clearState(store) {
  store.state = emptyState()
}

/**
 * Imports a normalized bundle into a Store.
 * @returns {object} report with counts and a conflict list
 */
export function importState(store, bundle, options = {}) {
  const mode = MERGE_MODES.includes(options.mode) ? options.mode : 'merge'
  const timestamp = iso(options.now)
  const source = bundle?.state ? bundle : parseBundle(bundle, { now: timestamp })
  const incoming = source.state
  const report = {
    mode,
    at: timestamp,
    banksAdded: 0,
    banksMapped: 0,
    entriesAdded: 0,
    entriesSkipped: 0,
    entriesRemapped: 0,
    linksAdded: 0,
    linksSkipped: 0,
    relationsRepaired: 0,
    conflicts: [],
  }

  if (mode === 'replace') clearState(store)

  const bankMap = new Map()
  for (const bank of Object.values(incoming.banks)) {
    const localById = store.state.banks[bank.id]
    if (localById) {
      bankMap.set(bank.id, localById.id)
      report.banksMapped += 1
      continue
    }
    const localByTitle = Object.values(store.state.banks).find(
      (candidate) => candidate.kind === bank.kind && candidate.title === bank.title,
    )
    if (localByTitle) {
      bankMap.set(bank.id, localByTitle.id)
      report.banksMapped += 1
      report.conflicts.push({ kind: 'bank-title-match', title: bank.title, mappedTo: localByTitle.id })
      continue
    }
    const id = store.state.banks[bank.id] ? freshId(store, 'bank') : bank.id
    store.state.banks[id] = { ...clone(bank), id }
    bankMap.set(bank.id, id)
    report.banksAdded += 1
  }

  const entryMap = new Map()
  const pending = []
  for (const entry of Object.values(incoming.entries)) {
    const targetBankId = bankMap.get(entry.bankId)
    if (!targetBankId) {
      report.conflicts.push({ kind: 'orphan-entry', id: entry.id, bankId: entry.bankId })
      continue
    }
    const localSameId = store.state.entries[entry.id]
    if (localSameId) {
      if (sameCore(localSameId, entry)) {
        entryMap.set(entry.id, localSameId.id)
        report.entriesSkipped += 1
        report.conflicts.push({ kind: 'duplicate-id', id: entry.id })
        continue
      }
      const id = freshId(store)
      entryMap.set(entry.id, id)
      report.entriesRemapped += 1
      report.conflicts.push({ kind: 'id-collision', id: entry.id, newId: id, topic: entry.topic })
      pending.push({ entry, id, targetBankId })
      continue
    }
    entryMap.set(entry.id, entry.id)
    pending.push({ entry, id: entry.id, targetBankId })
  }

  for (const item of pending) {
    const { entry, id, targetBankId } = item
    let status = entry.status
    let archivedAt = entry.archivedAt
    let archivedFrom = entry.archivedFrom
    const localActive = findActiveLocal(store.state, targetBankId, entry.topic)

    if (localActive && status === 'active') {
      if (localActive.claim === entry.claim) {
        entryMap.set(entry.id, localActive.id)
        report.entriesSkipped += 1
        report.conflicts.push({ kind: 'duplicate-topic', topic: entry.topic, bankId: targetBankId })
        continue
      }
      status = 'archived'
      archivedFrom = 'active'
      archivedAt = timestamp
      report.conflicts.push({
        kind: 'topic-taken',
        topic: entry.topic,
        bankId: targetBankId,
        importedId: id,
        localId: localActive.id,
        resolution: 'imported-as-archived',
      })
    }

    store.state.entries[id] = {
      ...clone(entry),
      id,
      bankId: targetBankId,
      status,
      ...(archivedAt ? { archivedAt } : {}),
      ...(archivedFrom ? { archivedFrom } : {}),
    }
    report.entriesAdded += 1
  }

  // Rewrite cross-entry references to the local ids, then repair anything that
  // remapping or skipping made dangling. Invariants win over preserving a link.
  for (const item of pending) {
    const entry = store.state.entries[item.id]
    if (!entry) continue
    if (entry.supersedes) {
      const mapped = entryMap.get(entry.supersedes)
      if (!mapped || mapped === item.id) {
        delete entry.supersedes
        report.relationsRepaired += 1
      } else {
        entry.supersedes = mapped
      }
    }
    if (entry.supersededBy) {
      const mapped = entryMap.get(entry.supersededBy)
      if (!mapped || mapped === item.id) {
        delete entry.supersededBy
        report.relationsRepaired += 1
      } else {
        entry.supersededBy = mapped
      }
    }
    const relations = []
    const seen = new Set()
    for (const relation of entry.relations ?? []) {
      const mapped = entryMap.get(relation.target)
      if (!mapped || mapped === item.id || seen.has(mapped) || !store.state.entries[mapped]) {
        report.relationsRepaired += 1
        continue
      }
      seen.add(mapped)
      relations.push({ ...relation, target: mapped })
    }
    entry.relations = relations
  }

  // Bidirectional supersede links must agree; only touch imported entries.
  for (const item of pending) {
    const entry = store.state.entries[item.id]
    if (!entry) continue
    if (entry.supersedes) {
      const predecessor = store.state.entries[entry.supersedes]
      if (!predecessor) {
        delete entry.supersedes
        report.relationsRepaired += 1
      } else if (predecessor.supersededBy && predecessor.supersededBy !== entry.id) {
        delete entry.supersedes
        report.relationsRepaired += 1
      } else {
        predecessor.supersededBy = entry.id
        predecessor.supersededAt ??= entry.createdAt
      }
    }
    if (entry.supersededBy) {
      const successor = store.state.entries[entry.supersededBy]
      if (!successor) {
        delete entry.supersededBy
        report.relationsRepaired += 1
      } else if (successor.supersedes && successor.supersedes !== entry.id) {
        delete entry.supersededBy
        report.relationsRepaired += 1
      } else {
        successor.supersedes = entry.id
      }
    }
  }

  for (const link of Object.values(incoming.links ?? {})) {
    const from = bankMap.get(link.fromBankId)
    const to = bankMap.get(link.toBankId)
    if (!from || !to || from === to) {
      report.linksSkipped += 1
      continue
    }
    const key = `${from}->${to}`
    if (store.state.links[key]) {
      report.linksSkipped += 1
      continue
    }
    store.state.links[key] = {
      fromBankId: from,
      toBankId: to,
      recall: Boolean(link.recall),
      query: link.query !== false,
    }
    report.linksAdded += 1
  }

  for (const [workspaceId, incomingBankId] of Object.entries(incoming.meta?.defaultBankByWorkspace ?? {})) {
    const mapped = bankMap.get(incomingBankId)
    if (mapped && !store.state.meta.defaultBankByWorkspace[workspaceId]) {
      store.state.meta.defaultBankByWorkspace[workspaceId] = mapped
    }
  }

  store.state.schemaVersion = SCHEMA_VERSION
  store.migrate()
  store.markAllDirty()
  report.stats = bundleStats(store.state)
  return report
}

// ------------------------------------------------------------------ Markdown

const KIND_MARK = { decision: '决策', constraint: '约束', gotcha: '坑', preference: '偏好', 'open-question': '未决' }
const STATUS_MARK = { active: '生效', superseded: '已取代', archived: '已停用', candidate: '候选' }

function escapeMarkdown(text) {
  return String(text ?? '').replace(/\\/g, '\\\\').replace(/\n{3,}/g, '\n\n')
}

export function renderMarkdown(state, options = {}) {
  const { bankIds = Object.keys(state.banks ?? {}), generatedAt = new Date() } = options
  const banks = Object.values(state.banks ?? {})
    .filter((bank) => bankIds.includes(bank.id))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
  const lines = [
    '# MemStack 记忆库导出',
    '',
    `导出时间：${iso(generatedAt)}`,
    `库：${banks.length} · 条目：${countOf(state.entries)}`,
    '',
  ]
  for (const bank of banks) {
    const entries = Object.values(state.entries ?? {})
      .filter((entry) => entry.bankId === bank.id)
      .sort((a, b) => {
        if (a.topic !== b.topic) return a.topic < b.topic ? -1 : 1
        return a.createdAt < b.createdAt ? -1 : 1
      })
    lines.push('---', '', `## ${bank.title}`, '')
    lines.push(
      `- 类型：${bank.kind}${bank.archivedAt ? '（已停用）' : ''}`,
      `- 描述：${bank.description || '（无）'}`,
      `- 条目：${entries.length}`,
      '',
    )
    for (const entry of entries) {
      lines.push(`### ${entry.topic}`, '')
      lines.push(
        `- 状态：${STATUS_MARK[entry.status] ?? entry.status} · 类型：${KIND_MARK[entry.kind] ?? entry.kind} · 置信：${entry.confidence}`,
        `- 更新：${entry.updatedAt}${entry.pinned ? ' · 固定' : ''}${(entry.tags ?? []).length ? ` · 标签：${entry.tags.join(', ')}` : ''}`,
        '',
        escapeMarkdown(entry.claim),
        '',
      )
      if (entry.detail) lines.push('**详情**', '', escapeMarkdown(entry.detail), '')
      if ((entry.rejected ?? []).length) {
        lines.push('**已否决**', '')
        for (const item of entry.rejected) {
          lines.push(`- ${item.option}${item.reason ? `：${item.reason}` : ''}`)
        }
        lines.push('')
      }
      if ((entry.relations ?? []).length) {
        lines.push('**关系**', '')
        for (const relation of entry.relations) {
          const target = state.entries?.[relation.target]
          lines.push(`- ${relation.type} → ${target?.topic ?? relation.target}${relation.note ? `：${relation.note}` : ''}`)
        }
        lines.push('')
      }
      if (entry.supersedes) lines.push(`> 取代了 \`${state.entries?.[entry.supersedes]?.topic ?? entry.supersedes}\``, '')
      if (entry.supersededBy) lines.push(`> 已被 \`${state.entries?.[entry.supersededBy]?.topic ?? entry.supersededBy}\` 取代`, '')
    }
  }
  return `${lines.join('\n').trimEnd()}\n`
}
