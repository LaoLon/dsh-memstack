import test from 'node:test'
import assert from 'node:assert/strict'
import {
  clampStability,
  decayAnchor,
  initialStability,
  isDormant,
  nextReviewAt,
  recallPatch,
  retentionOf,
  retentionSeries,
  reviewPatch,
  scoreOf,
  stageOf,
} from '../lib/decay.js'

const NOW = new Date('2026-06-01T00:00:00.000Z')
const DAY = 86_400_000

function entry(overrides = {}) {
  return {
    id: 'entry_1',
    kind: 'decision',
    confidence: 'verified',
    pinned: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastReviewedAt: '2026-01-01T00:00:00.000Z',
    stabilityDays: 60,
    reviewCount: 0,
    recalledCount: 0,
    ...overrides,
  }
}

const daysAgo = (days) => new Date(NOW.getTime() - days * DAY).toISOString()

test('留存率在半个衰期后正好减半', () => {
  const value = retentionOf(entry({ lastReviewedAt: daysAgo(30) }), NOW)
  assert.ok(Math.abs(value - 0.5 ** 0.5) < 1e-9, `got ${value}`)

  const half = retentionOf(entry({ lastReviewedAt: daysAgo(60) }), NOW)
  assert.ok(Math.abs(half - 0.5) < 1e-9, `got ${half}`)
})

test('刚写下的记忆留存率为 1，衰减单调不增', () => {
  assert.equal(retentionOf(entry({ lastReviewedAt: NOW.toISOString() }), NOW), 1)
  let previous = 1
  for (const days of [1, 7, 30, 90, 365]) {
    const value = retentionOf(entry({ lastReviewedAt: daysAgo(days) }), NOW)
    assert.ok(value <= previous, `not monotonic at ${days}`)
    previous = value
  }
})

test('阶段边界与沉寂阈值一致', () => {
  assert.equal(stageOf(1), 'fresh')
  assert.equal(stageOf(0.8), 'fresh')
  assert.equal(stageOf(0.79), 'stable')
  assert.equal(stageOf(0.5), 'stable')
  assert.equal(stageOf(0.49), 'fading')
  assert.equal(stageOf(0.2), 'fading')
  assert.equal(stageOf(0.19), 'dormant')
  assert.equal(isDormant(entry({ lastReviewedAt: daysAgo(400) }), NOW), true)
  assert.equal(isDormant(entry({ lastReviewedAt: daysAgo(1) }), NOW), false)
})

test('初始稳定度按类型、置信度与固定状态缩放并夹在范围内', () => {
  assert.equal(initialStability({ kind: 'preference' }), 120)
  assert.equal(initialStability({ kind: 'open-question' }), 14)
  assert.equal(initialStability({ kind: 'decision', confidence: 'tentative' }), 21)
  assert.equal(initialStability({ kind: 'decision', pinned: true }), 240)
  assert.equal(initialStability({ kind: 'preference', pinned: true }), 480)
  assert.equal(clampStability(0.01), 0.5)
  assert.equal(clampStability(9999), 730)
  assert.equal(clampStability('nope'), 60)
})

test('复习提升稳定度 1.8 倍并重置时钟与计数', () => {
  const patch = reviewPatch(entry({ stabilityDays: 60, reviewCount: 2 }), NOW)
  assert.equal(patch.stabilityDays, 108)
  assert.equal(patch.lastReviewedAt, NOW.toISOString())
  assert.equal(patch.reviewCount, 3)
  assert.equal(reviewPatch(entry({ stabilityDays: 500 }), NOW).stabilityDays, 730)
})

test('召回增益与当时留存率成反比：越难想起，加固越多', () => {
  const fresh = recallPatch(entry({ lastReviewedAt: NOW.toISOString(), stabilityDays: 60 }), NOW)
  assert.equal(fresh.stabilityDays, 60)
  assert.equal(fresh.recalledCount, 1)

  const faded = recallPatch(entry({ lastReviewedAt: daysAgo(60), stabilityDays: 60 }), NOW)
  assert.ok(faded.stabilityDays > 60 && faded.stabilityDays < 75, `got ${faded.stabilityDays}`)
})

test('被取代/停用条目的衰减从结束时刻起算，而不是从创建时刻', () => {
  const frozen = entry({
    createdAt: '2025-01-01T00:00:00.000Z',
    lastReviewedAt: '2025-01-01T00:00:00.000Z',
    supersededAt: daysAgo(30),
    stabilityDays: 60,
  })
  assert.equal(decayAnchor(frozen), frozen.supersededAt)
  const atNow = retentionOf(frozen, NOW)
  const later = retentionOf(frozen, new Date(NOW.getTime() + 90 * DAY))
  assert.ok(later < atNow, 'history keeps fading from the supersede point')
  assert.ok(Math.abs(atNow - 0.5 ** (30 / 60)) < 1e-9)
  // If the anchor were createdAt, a year-old chain would be effectively forgotten.
  const withoutSupersedeAt = retentionOf({ ...frozen, supersededAt: undefined }, NOW)
  assert.ok(withoutSupersedeAt < 0.01, `expected near-zero, got ${withoutSupersedeAt}`)

  const archived = entry({ archivedAt: daysAgo(60), stabilityDays: 60 })
  assert.ok(Math.abs(retentionOf(archived, NOW) - 0.5) < 1e-9)
})

test('nextReviewAt 是锚点加一个衰期', () => {
  const target = entry({ lastReviewedAt: '2026-05-01T00:00:00.000Z', stabilityDays: 30 })
  assert.equal(nextReviewAt(target), '2026-05-31T00:00:00.000Z')
})

test('scoreOf 让约束与坑在预算压力下更靠前', () => {
  const base = entry({ lastReviewedAt: daysAgo(30), stabilityDays: 60 })
  assert.ok(scoreOf({ ...base, kind: 'constraint' }, NOW) > scoreOf({ ...base, kind: 'decision' }, NOW))
  assert.ok(scoreOf({ ...base, kind: 'decision' }, NOW) > scoreOf({ ...base, kind: 'preference' }, NOW))
})

test('retentionSeries 给出单调下降的采样点', () => {
  const series = retentionSeries(entry({ lastReviewedAt: daysAgo(10) }), NOW, { points: 12, horizonDays: 120 })
  assert.equal(series.length, 12)
  assert.equal(series[0].days, 0)
  assert.equal(series[0].retention, 1)
  assert.equal(series.at(-1).days, 120)
  for (let index = 1; index < series.length; index += 1) {
    assert.ok(series[index].retention <= series[index - 1].retention)
  }
})
