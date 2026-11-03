import test from 'node:test'
import assert from 'node:assert/strict'
import { edgeStyle } from '../console/graph3d.js'

const TYPES = ['contains', 'supersede', 'relation', 'topic', 'tag', 'bank-link']

test('每种边在默认视距下都过可见性下限', () => {
  for (const type of TYPES) {
    const style = edgeStyle({ type, weight: 0.3 }, { scale: 1, depth: 1050 })
    assert.ok(style.alpha >= 0.2, `${type} 的 alpha=${style.alpha} 太淡`)
    assert.ok(style.width >= 1.4, `${type} 的线宽=${style.width} 不足 1.4px`)
  }
})

test('结构边（contains/topic）在权重 0.35 时仍然可见', () => {
  // 2026-11-03 反馈"只看到点、看不到边"：contains 权重 0.35、alpha 0.16、线宽 0.36px。
  const contains = edgeStyle({ type: 'contains', weight: 0.35 }, { scale: 1, depth: 1050 })
  assert.ok(contains.alpha >= 0.24, `contains alpha=${contains.alpha}`)
  assert.ok(contains.width >= 2, `contains width=${contains.width}`)
})

test('关系边比包含边更显眼', () => {
  const contains = edgeStyle({ type: 'contains', weight: 0.35 })
  const relation = edgeStyle({ type: 'relation', weight: 1 })
  assert.ok(relation.width > contains.width, '关系边应更粗')
  assert.ok(relation.alpha > contains.alpha, '关系边应更亮')
})

test('远、小的节点上的边仍不低于可读下限', () => {
  const far = edgeStyle({ type: 'contains', weight: 0.35 }, { scale: 0.25, depth: 2600 })
  assert.ok(far.alpha >= 0.15, `远边 alpha=${far.alpha}`)
  assert.ok(far.width >= 1.4, `远边 width=${far.width}`)
})

test('topic / tag 画虚线，其余实线', () => {
  assert.equal(edgeStyle({ type: 'topic' }).dashed, true)
  assert.equal(edgeStyle({ type: 'tag' }).dashed, true)
  for (const type of ['contains', 'supersede', 'relation', 'bank-link']) {
    assert.equal(edgeStyle({ type }).dashed, false, `${type} 应为实线`)
  }
})

test('未知类型的边按包含边兜底，不会变成 0', () => {
  const style = edgeStyle({ type: 'unknown', weight: 0.3 }, { scale: 1, depth: 1050 })
  assert.ok(style.alpha >= 0.2)
  assert.ok(style.width >= 1.4)
  const bare = edgeStyle(undefined)
  assert.ok(bare.alpha > 0 && bare.width >= 1.4)
})
