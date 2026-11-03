/**
 * Forgetting curve — Ebbinghaus-style exponential decay, plus the spacing-effect
 * reinforcement used when a memory is recalled or explicitly reviewed.
 *
 * Pure and dependency-free: every function takes the entry and an explicit clock,
 * so the whole model is deterministic under test. Nothing here mutates state;
 * mutations go through `store.js`.
 *
 * `stabilityDays` is a half-life: the number of days after which the chance of
 * remembering an entry is 50%. Retention only decides *how likely the memory is
 * surfaced*, never whether the conclusion is true.
 */

export const KIND_STABILITY = {
  decision: 60,
  constraint: 90,
  gotcha: 90,
  preference: 120,
  'open-question': 14,
}

/** Ranking weight: constraints and gotchas outrank preferences under budget pressure. */
export const KIND_IMPORTANCE = {
  decision: 1,
  constraint: 1.15,
  gotcha: 1.1,
  preference: 0.95,
  'open-question': 0.9,
}

export const CONFIDENCE_FACTOR = { verified: 1, tentative: 0.35 }
export const PINNED_FACTOR = 4
export const MIN_STABILITY_DAYS = 0.5
export const MAX_STABILITY_DAYS = 730
export const REVIEW_GAIN = 1.8
export const RECALL_GAIN = 0.25

export const STAGES = [
  { id: 'fresh', label: '新鲜', min: 0.8 },
  { id: 'stable', label: '稳定', min: 0.5 },
  { id: 'fading', label: '淡化', min: 0.2 },
  { id: 'dormant', label: '沉寂', min: 0 },
]

const DAY_MS = 86_400_000
const STAGE_BY_ID = new Map(STAGES.map((stage) => [stage.id, stage]))

export function clampStability(days) {
  const number = Number(days)
  if (!Number.isFinite(number)) return KIND_STABILITY.decision
  return Math.min(MAX_STABILITY_DAYS, Math.max(MIN_STABILITY_DAYS, number))
}

export function toDate(value, fallback = new Date()) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? fallback : value
  const parsed = new Date(value ?? NaN)
  return Number.isNaN(parsed.getTime()) ? fallback : parsed
}

export function initialStability({ kind = 'decision', confidence = 'verified', pinned = false } = {}) {
  const base = KIND_STABILITY[kind] ?? KIND_STABILITY.decision
  const confidenceFactor = CONFIDENCE_FACTOR[confidence] ?? 1
  const pinnedFactor = pinned ? PINNED_FACTOR : 1
  return clampStability(base * confidenceFactor * pinnedFactor)
}

export function stabilityOf(entry) {
  return clampStability(entry?.stabilityDays ?? initialStability(entry ?? {}))
}

/**
 * When a superseded or archived entry stopped being maintained, retention is
 * frozen at that instant. Otherwise a three-year-old history chain would always
 * read as "forgotten" and drown the graph in noise.
 */
export function decayAnchor(entry) {
  return entry?.supersededAt ?? entry?.archivedAt ?? entry?.lastReviewedAt ?? entry?.createdAt
}

export function ageDays(entry, now = new Date()) {
  const anchor = toDate(decayAnchor(entry), toDate(now))
  const elapsed = toDate(now).getTime() - anchor.getTime()
  return Math.max(0, elapsed / DAY_MS)
}

/** Retention in (0, 1]. 1 means "reviewed right now". */
export function retentionOf(entry, now = new Date()) {
  const age = ageDays(entry, now)
  const halfLife = stabilityOf(entry)
  const retention = 0.5 ** (age / halfLife)
  if (!Number.isFinite(retention)) return 0
  return Math.min(1, Math.max(0, retention))
}

export function stageOf(retention) {
  const value = Number.isFinite(retention) ? retention : 0
  for (const stage of STAGES) {
    if (value >= stage.min) return stage.id
  }
  return 'dormant'
}

export function stageLabel(id) {
  return STAGE_BY_ID.get(id)?.label ?? id
}

export function importanceOf(entry) {
  return KIND_IMPORTANCE[entry?.kind] ?? 1
}

/** Retention weighted by how much this kind of judgment matters. */
export function scoreOf(entry, now = new Date()) {
  return importanceOf(entry) * retentionOf(entry, now) ** 0.7
}

export function isDormant(entry, now = new Date()) {
  return retentionOf(entry, now) < 0.2
}

/** The moment retention is expected to reach 50%, i.e. the next natural review. */
export function nextReviewAt(entry) {
  const anchor = toDate(decayAnchor(entry))
  return new Date(anchor.getTime() + stabilityOf(entry) * DAY_MS).toISOString()
}

/** Full read model for one entry; used by the console, tools and tests. */
export function describeDecay(entry, now = new Date()) {
  const retention = retentionOf(entry, now)
  const stage = stageOf(retention)
  return {
    retention: Number(retention.toFixed(4)),
    stage,
    stageLabel: stageLabel(stage),
    stabilityDays: Number(stabilityOf(entry).toFixed(2)),
    ageDays: Number(ageDays(entry, now).toFixed(2)),
    nextReviewAt: nextReviewAt(entry),
    reviewedAt: entry?.lastReviewedAt ?? entry?.createdAt ?? null,
  }
}

/** Patch for "the user confirmed this is still true" (spaced repetition success). */
export function reviewPatch(entry, now = new Date()) {
  const timestamp = toDate(now).toISOString()
  return {
    stabilityDays: clampStability(stabilityOf(entry) * REVIEW_GAIN),
    lastReviewedAt: timestamp,
    reviewCount: Number(entry?.reviewCount ?? 0) + 1,
  }
}

/** Patch for "this memory was surfaced": easier recall earns less extra stability. */
export function recallPatch(entry, now = new Date()) {
  const timestamp = toDate(now).toISOString()
  const retention = retentionOf(entry, now)
  const gain = 1 + RECALL_GAIN * (1 - retention)
  return {
    stabilityDays: clampStability(stabilityOf(entry) * gain),
    lastRecalledAt: timestamp,
    recalledCount: Number(entry?.recalledCount ?? 0) + 1,
  }
}

/** Samples the decay curve for a sparkline, from the anchor to `now` plus `horizonDays`. */
export function retentionSeries(entry, now = new Date(), { points = 24, horizonDays = null } = {}) {
  const anchor = toDate(decayAnchor(entry))
  const halfLife = stabilityOf(entry)
  const span = horizonDays ?? Math.max(halfLife * 2, ageDays(entry, now) * 1.25, 1)
  const series = []
  for (let index = 0; index < points; index += 1) {
    const offset = (span / (points - 1)) * index
    const at = new Date(anchor.getTime() + offset * DAY_MS)
    series.push({
      at: at.toISOString(),
      days: Number(offset.toFixed(2)),
      retention: Number(0.5 ** (offset / halfLife).toFixed(4)),
    })
  }
  return series
}
