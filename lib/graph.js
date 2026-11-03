/**
 * Graph projection over the memory state. Pure: it reads a snapshot and returns
 * nodes + edges for the console. No layout here — the renderer owns geometry.
 *
 * Structural edges (contains / supersede / relation / bank-link) come from the
 * data model. Derived edges (topic family / shared tag) are a bounded, readable
 * heuristic: chain neighbours by recency instead of building a clique, so a
 * popular tag does not turn the graph into a hairball.
 */

import { describeDecay, stageOf } from './decay.js'
import { RELATION_TYPES } from './store.js'

export const EDGE_TYPES = ['contains', 'supersede', 'relation', 'topic', 'tag', 'bank-link']

const RELATION_WEIGHT = { contradicts: 1.6, depends: 1.45, refines: 1.25, related: 0.9 }
const RELATION_COLOR = { contradicts: 'conflict', depends: 'dependency', refines: 'refine', related: 'related' }

export function buildGraph(state, options = {}) {
  const {
    now = new Date(),
    includeInactive = true,
    includeDerived = true,
    maxDerivedPerNode = 3,
    includeBankLinks = true,
  } = options

  const banks = Object.values(state?.banks ?? {})
  const entries = Object.values(state?.entries ?? {}).filter((entry) => includeInactive || entry.status === 'active')
  const bankIds = new Set(banks.map((bank) => bank.id))
  const entryIds = new Set(entries.map((entry) => entry.id))

  const nodes = []
  const edges = []
  const edgeKeys = new Set()
  const degree = new Map()

  const pushEdge = (edge) => {
    if (!edge.source || !edge.target || edge.source === edge.target) return
    const [left, right] = edge.directed ? [edge.source, edge.target] : [edge.source, edge.target].sort()
    const key = `${edge.type}:${left}->${right}`
    if (edgeKeys.has(key)) return
    edgeKeys.add(key)
    edges.push(edge)
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1)
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
  }

  for (const bank of banks) {
    const report = describeDecaySafe(bank, now)
    nodes.push({
      id: bank.id,
      type: 'bank',
      label: bank.title,
      title: bank.title,
      bankId: bank.id,
      bankTitle: bank.title,
      bankKind: bank.kind,
      status: bank.archivedAt ? 'archived' : 'active',
      description: bank.description ?? '',
      entryCount: entries.filter((entry) => entry.bankId === bank.id).length,
      retention: null,
      stage: null,
      tags: [],
      ...report,
    })
  }

  for (const entry of entries) {
    const bank = state.banks?.[entry.bankId]
    if (!bankIds.has(entry.bankId)) continue
    const decay = describeDecay(entry, now)
    nodes.push({
      id: entry.id,
      type: 'entry',
      label: entry.claim,
      title: entry.claim,
      topic: entry.topic,
      claim: entry.claim,
      kind: entry.kind,
      status: entry.status,
      confidence: entry.confidence,
      pinned: Boolean(entry.pinned),
      bankId: entry.bankId,
      bankTitle: bank?.title ?? entry.bankId,
      tags: entry.tags ?? [],
      rejected: entry.rejected ?? [],
      updatedAt: entry.updatedAt,
      createdAt: entry.createdAt,
      retention: decay.retention,
      stage: decay.stage,
      stabilityDays: decay.stabilityDays,
      ageDays: decay.ageDays,
      nextReviewAt: decay.nextReviewAt,
      recalledCount: entry.recalledCount ?? 0,
      reviewCount: entry.reviewCount ?? 0,
    })
  }

  for (const entry of entries) {
    if (!entryIds.has(entry.id)) continue
    pushEdge({
      id: `contains:${entry.bankId}->${entry.id}`,
      type: 'contains',
      source: entry.bankId,
      target: entry.id,
      weight: 0.35,
      directed: false,
    })
  }

  for (const entry of entries) {
    if (entry.supersedes && entryIds.has(entry.supersedes)) {
      pushEdge({
        id: `supersede:${entry.supersedes}->${entry.id}`,
        type: 'supersede',
        source: entry.supersedes,
        target: entry.id,
        weight: 1.35,
        directed: true,
        label: 'supersedes',
      })
    }
  }

  for (const entry of entries) {
    for (const relation of entry.relations ?? []) {
      if (!entryIds.has(relation.target)) continue
      if (!RELATION_TYPES.includes(relation.type)) continue
      pushEdge({
        id: `relation:${entry.id}->${relation.target}:${relation.type}`,
        type: 'relation',
        subtype: relation.type,
        color: RELATION_COLOR[relation.type] ?? 'related',
        source: entry.id,
        target: relation.target,
        weight: RELATION_WEIGHT[relation.type] ?? 1,
        directed: relation.type !== 'related',
        label: relation.type,
        note: relation.note,
      })
    }
  }

  if (includeDerived) {
    const active = entries.filter((entry) => entry.status === 'active')
    const byRecency = [...active].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))

    const topicGroups = new Map()
    for (const entry of byRecency) {
      if (!entry.topic.includes('.')) continue
      const family = entry.topic.split('.')[0]
      if (!topicGroups.has(family)) topicGroups.set(family, [])
      topicGroups.get(family).push(entry)
    }
    for (const [family, group] of topicGroups) {
      if (group.length < 2) continue
      for (let index = 0; index < group.length; index += 1) {
        const entry = group[index]
        const neighbours = group.filter((_, position) => position !== index).slice(0, maxDerivedPerNode)
        for (const neighbour of neighbours) {
          pushEdge({
            id: `topic:${family}:${entry.id}->${neighbour.id}`,
            type: 'topic',
            source: entry.id,
            target: neighbour.id,
            weight: 0.3,
            directed: false,
            label: family,
          })
        }
      }
    }

    const tagGroups = new Map()
    for (const entry of byRecency) {
      for (const tag of entry.tags ?? []) {
        if (!tagGroups.has(tag)) tagGroups.set(tag, [])
        tagGroups.get(tag).push(entry)
      }
    }
    for (const [tag, group] of tagGroups) {
      if (group.length < 2) continue
      for (let index = 0; index < group.length; index += 1) {
        const entry = group[index]
        const neighbours = group.filter((_, position) => position !== index).slice(0, maxDerivedPerNode)
        for (const neighbour of neighbours) {
          pushEdge({
            id: `tag:${tag}:${entry.id}->${neighbour.id}`,
            type: 'tag',
            source: entry.id,
            target: neighbour.id,
            weight: 0.22,
            directed: false,
            label: tag,
          })
        }
      }
    }
  }

  if (includeBankLinks) {
    for (const link of Object.values(state?.links ?? {})) {
      if (!bankIds.has(link.fromBankId) || !bankIds.has(link.toBankId)) continue
      pushEdge({
        id: `bank-link:${link.fromBankId}->${link.toBankId}`,
        type: 'bank-link',
        source: link.fromBankId,
        target: link.toBankId,
        weight: 2,
        directed: true,
        label: [link.recall ? 'recall' : null, link.query ? 'query' : null].filter(Boolean).join(' + '),
        recall: Boolean(link.recall),
        query: Boolean(link.query),
      })
    }
  }

  for (const node of nodes) node.degree = degree.get(node.id) ?? 0

  return {
    generatedAt: new Date(now).toISOString(),
    nodes,
    edges,
    summary: summarize(entries, banks, nodes, edges, now),
  }
}

function describeDecaySafe(bank, now) {
  // Banks have no decay; the fields stay null so the renderer can branch on type.
  void bank
  void now
  return {}
}

/** Counts used by the header chips and the data view. */
export function summarize(entries, banks, nodes, edges, now = new Date()) {
  const active = entries.filter((entry) => entry.status === 'active')
  const byKind = {}
  const byStatus = {}
  const byStage = { fresh: 0, stable: 0, fading: 0, dormant: 0 }
  let retentionSum = 0
  for (const entry of entries) {
    byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1
    byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1
  }
  for (const entry of active) {
    const retention = describeDecay(entry, now).retention
    retentionSum += retention
    byStage[stageOf(retention)] += 1
  }
  return {
    banks: banks.length,
    banksActive: banks.filter((bank) => !bank.archivedAt).length,
    entries: entries.length,
    active: active.length,
    superseded: byStatus.superseded ?? 0,
    archived: byStatus.archived ?? 0,
    candidates: byStatus.candidate ?? 0,
    pinned: active.filter((entry) => entry.pinned).length,
    tags: new Set(entries.flatMap((entry) => entry.tags ?? [])).size,
    byKind,
    byStage,
    averageRetention: active.length ? Number((retentionSum / active.length).toFixed(3)) : 0,
    nodes: nodes.length,
    edges: edges.length,
    reviewedRecently: entries.filter((entry) => entry.lastReviewedAt && withinDays(entry.lastReviewedAt, now, 7)).length,
  }
}

function withinDays(value, now, days) {
  const time = new Date(value).getTime()
  if (!Number.isFinite(time)) return false
  return new Date(now).getTime() - time <= days * 86_400_000
}
