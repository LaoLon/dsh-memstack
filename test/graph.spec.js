import test from 'node:test'
import assert from 'node:assert/strict'
import { makeWorkspaceStore } from '../test-support/helpers.js'
import { buildGraph } from '../lib/graph.js'
import { linkKey } from '../lib/store.js'

const NOW = '2026-06-01T00:00:00.000Z'

function sample() {
  const { store, bankId } = makeWorkspaceStore()
  const topicBank = store.createBank({ kind: 'topic', title: 'spdk-domain', description: 'storage' })
  const a = store.writeEntry({
    bankId,
    topic: 'spdk.a',
    kind: 'decision',
    claim: 'A 结论',
    tags: ['perf', 'nvme'],
  })
  const b = store.writeEntry({
    bankId,
    topic: 'spdk.b',
    kind: 'constraint',
    claim: 'B 结论',
    tags: ['perf'],
  })
  store.relate(a.entry.id, b.entry.id, 'depends', 'A 依赖 B')
  const c = store.writeEntry({ bankId, topic: 'spdk.a', kind: 'decision', claim: 'A 新结论', tags: ['perf'] })
  store.state.links[linkKey(bankId, topicBank.id)] = {
    fromBankId: bankId,
    toBankId: topicBank.id,
    recall: true,
    query: true,
  }
  return { store, bankId, topicBank, a, b, c }
}

test('图谱包含库节点与条目节点，并按归属连边', () => {
  const { store, bankId } = sample()
  const graph = buildGraph(store.toJSON(), { now: NOW })
  assert.equal(graph.nodes.filter((node) => node.type === 'bank').length, 2)
  assert.equal(graph.nodes.filter((node) => node.type === 'entry').length, 3)
  assert.ok(graph.edges.filter((edge) => edge.type === 'contains').length >= 3)
  const contains = graph.edges.find((edge) => edge.type === 'contains' && edge.source === bankId)
  assert.ok(contains)
  assert.ok(graph.nodes.every((node) => node.type !== 'entry' || graph.nodes.some((bank) => bank.id === node.bankId)))
})

test('取代链产生有向 supersede 边，方向从旧到新', () => {
  const { store, a, c } = sample()
  const graph = buildGraph(store.toJSON(), { now: NOW })
  const edge = graph.edges.find((candidate) => candidate.type === 'supersede')
  assert.ok(edge)
  assert.equal(edge.directed, true)
  assert.equal(edge.source, a.entry.id)
  assert.equal(edge.target, c.entry.id)
})

test('显式关系保留 subtype 与备注', () => {
  const { store, a, b } = sample()
  const graph = buildGraph(store.toJSON(), { now: NOW })
  const edge = graph.edges.find((candidate) => candidate.type === 'relation')
  assert.ok(edge)
  assert.equal(edge.subtype, 'depends')
  assert.equal(edge.source, a.entry.id)
  assert.equal(edge.target, b.entry.id)
  assert.equal(edge.note, 'A 依赖 B')
  assert.equal(edge.directed, true)
})

test('派生边按主题族与共享标签连接，且每节点数量受限', () => {
  const { store } = sample()
  const graph = buildGraph(store.toJSON(), { now: NOW, maxDerivedPerNode: 1 })
  assert.ok(graph.edges.some((edge) => edge.type === 'topic'))
  assert.ok(graph.edges.some((edge) => edge.type === 'tag'))
  const perNode = new Map()
  for (const edge of graph.edges.filter((candidate) => candidate.type === 'tag')) {
    for (const id of [edge.source, edge.target]) perNode.set(id, (perNode.get(id) ?? 0) + 1)
  }
  for (const count of perNode.values()) assert.ok(count <= 1)
})

test('includeDerived: false 只保留结构边', () => {
  const { store } = sample()
  const graph = buildGraph(store.toJSON(), { now: NOW, includeDerived: false })
  assert.ok(graph.edges.every((edge) => !['topic', 'tag'].includes(edge.type)))
})

test('includeInactive: false 排除已被取代的条目与相关边', () => {
  const { store, a, c } = sample()
  const graph = buildGraph(store.toJSON(), { now: NOW, includeInactive: false })
  assert.ok(!graph.nodes.some((node) => node.id === a.entry.id))
  assert.ok(graph.nodes.some((node) => node.id === c.entry.id))
  assert.ok(!graph.edges.some((edge) => edge.source === a.entry.id || edge.target === a.entry.id))
})

test('库关联边连接两个库节点', () => {
  const { store, bankId, topicBank } = sample()
  const graph = buildGraph(store.toJSON(), { now: NOW })
  const edge = graph.edges.find((candidate) => candidate.type === 'bank-link')
  assert.ok(edge)
  assert.equal(edge.source, bankId)
  assert.equal(edge.target, topicBank.id)
})

test('每条边都指向存在的节点，且无重复边', () => {
  const { store } = sample()
  const graph = buildGraph(store.toJSON(), { now: NOW })
  const ids = new Set(graph.nodes.map((node) => node.id))
  const keys = new Set()
  for (const edge of graph.edges) {
    assert.ok(ids.has(edge.source), `missing source ${edge.source}`)
    assert.ok(ids.has(edge.target), `missing target ${edge.target}`)
    const [left, right] = edge.directed ? [edge.source, edge.target] : [edge.source, edge.target].sort()
    const key = `${edge.type}:${left}->${right}`
    assert.ok(!keys.has(key), `duplicate edge ${key}`)
    keys.add(key)
  }
  for (const node of graph.nodes) {
    if (node.type === 'entry') assert.ok(graph.edges.some((edge) => edge.source === node.id || edge.target === node.id))
  }
})

test('summary 汇总节点、类型、阶段与平均留存', () => {
  const { store } = sample()
  const graph = buildGraph(store.toJSON(), { now: NOW })
  const summary = graph.summary
  assert.equal(summary.nodes, graph.nodes.length)
  assert.equal(summary.edges, graph.edges.length)
  assert.equal(summary.banks, 2)
  assert.equal(summary.entries, 3)
  assert.equal(summary.active, 2)
  assert.equal(summary.superseded, 1)
  assert.ok(summary.averageRetention > 0 && summary.averageRetention <= 1)
  assert.equal(summary.byStage.fresh + summary.byStage.stable + summary.byStage.fading + summary.byStage.dormant, 2)
})
