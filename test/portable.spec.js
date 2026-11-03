import test from 'node:test'
import assert from 'node:assert/strict'
import { makeStore, makeWorkspaceStore } from '../test-support/helpers.js'
import { linkKey } from '../lib/store.js'
import {
  BUNDLE_FORMAT,
  buildBundle,
  bundleStats,
  importState,
  parseBundle,
  renderMarkdown,
  serializeBundle,
} from '../lib/portable.js'

const NOW = '2026-06-01T00:00:00.000Z'

function source() {
  const { store, bankId } = makeWorkspaceStore()
  const topicBank = store.createBank({ kind: 'topic', title: 'domain', description: '领域知识' })
  const first = store.writeEntry({
    bankId,
    topic: 'svc.a',
    kind: 'decision',
    claim: '旧结论',
    detail: '旧依据',
    tags: ['perf', 'nvme'],
    rejected: [{ option: '旧方案', reason: '实测不可行' }],
  })
  const second = store.writeEntry({ bankId, topic: 'svc.a', kind: 'decision', claim: '新结论' })
  const other = store.writeEntry({ bankId: topicBank.id, topic: 'domain.b', kind: 'gotcha', claim: '领域坑' })
  store.relate(second.entry.id, other.entry.id, 'depends', '链路')
  store.state.links[linkKey(bankId, topicBank.id)] = {
    fromBankId: bankId,
    toBankId: topicBank.id,
    recall: true,
    query: true,
  }
  return { store, bankId, topicBank, first, second, other }
}

function bundleOf(store) {
  return buildBundle(store.toJSON(), { now: NOW, machine: 'test', platform: 'test' })
}

test('bundle 带格式版本与统计，可序列化并原样解析', () => {
  const { store } = source()
  const bundle = bundleOf(store)
  assert.equal(bundle.format, BUNDLE_FORMAT)
  assert.equal(bundle.version, 2)
  assert.deepEqual(bundle.stats, { banks: 2, entries: 3, active: 2, superseded: 1, archived: 0, links: 1 })

  const parsed = parseBundle(serializeBundle(bundle))
  assert.equal(parsed.legacy, false)
  assert.equal(parsed.source.machine, 'test')
  assert.equal(Object.keys(parsed.state.entries).length, 3)
  assert.deepEqual(bundleStats(parsed.state), bundle.stats)
})

test('导入空库：保留 id、取代链、关系与库关联', () => {
  const { store, bankId, topicBank, first, second, other } = source()
  const target = makeStore()
  const report = importState(target, bundleOf(store), { now: NOW })

  assert.equal(report.banksAdded, 2)
  assert.equal(report.banksMapped, 0)
  assert.equal(report.entriesAdded, 3)
  assert.equal(report.entriesSkipped, 0)
  assert.equal(report.entriesRemapped, 0)
  assert.equal(report.linksAdded, 1)
  assert.equal(report.conflicts.length, 0)

  const state = target.toJSON()
  assert.deepEqual(Object.keys(state.banks).sort(), [bankId, topicBank.id].sort())
  assert.equal(state.entries[second.entry.id].supersedes, first.entry.id)
  assert.equal(state.entries[first.entry.id].supersededBy, second.entry.id)
  assert.equal(state.entries[first.entry.id].status, 'superseded')
  assert.equal(state.entries[second.entry.id].relations[0].target, other.entry.id)
  assert.equal(state.entries[second.entry.id].relations[0].type, 'depends')
  assert.ok(state.links[linkKey(bankId, topicBank.id)].recall)
  assert.deepEqual(target.assertInvariants(), [])
})

test('合并同一 bundle 是幂等的：全部按 duplicate-id 跳过', () => {
  const { store } = source()
  const target = makeStore()
  importState(target, bundleOf(store), { now: NOW })
  const before = Object.keys(target.state.entries).length

  const report = importState(target, bundleOf(store), { now: NOW })
  assert.equal(report.entriesAdded, 0)
  assert.equal(report.entriesSkipped, 3)
  assert.equal(report.entriesRemapped, 0)
  assert.equal(report.linksAdded, 0)
  assert.equal(Object.keys(target.state.entries).length, before)
  assert.deepEqual(target.assertInvariants(), [])
})

test('同 id 不同结论：重映射为新 id，并报告 id-collision', () => {
  const { store } = source()
  const target = makeStore()
  importState(target, bundleOf(store), { now: NOW })
  const bundle = bundleOf(store)
  const victimId = Object.keys(bundle.state.entries)[0]
  bundle.state.entries[victimId].claim = '对方机器上改过的结论'

  const report = importState(target, bundle, { now: NOW })
  assert.equal(report.entriesRemapped, 1)
  assert.equal(report.conflicts.filter((conflict) => conflict.kind === 'id-collision').length, 1)
  assert.equal(Object.keys(target.state.entries).length, 4)
  assert.deepEqual(target.assertInvariants(), [])
})

test('同库同主题但结论不同：导入项归档，本地结论不被覆盖', () => {
  const { store, bankId, second } = source()
  const target = makeStore()
  const localBank = target.createBank({ kind: 'workspace', title: 'spdk-storage' })
  target.writeEntry({ bankId: localBank.id, topic: 'svc.a', kind: 'decision', claim: '本地结论' })
  const bundle = bundleOf(store)
  bundle.state.banks = { [bankId]: store.state.banks[bankId] }
  bundle.state.entries = {
    entry_foreign: { ...store.state.entries[second.entry.id], id: 'entry_foreign' },
  }
  bundle.state.links = {}
  bundle.state.entries.entry_foreign.claim = '对方结论'
  bundle.state.entries.entry_foreign.supersedes = undefined
  bundle.state.entries.entry_foreign.supersededBy = undefined

  const report = importState(target, bundle, { now: NOW })
  const conflict = report.conflicts.find((item) => item.kind === 'topic-taken')
  assert.ok(conflict)
  assert.equal(target.state.entries.entry_foreign.status, 'archived')
  assert.equal(target.findActive(localBank.id, 'svc.a').claim, '本地结论')
  assert.deepEqual(target.assertInvariants(), [])
})

test('replace 模式清空本地原有内容', () => {
  const { store } = source()
  const target = makeStore()
  target.createBank({ kind: 'workspace', title: 'keep-me' })
  const report = importState(target, bundleOf(store), { mode: 'replace', now: NOW })
  assert.equal(report.mode, 'replace')
  assert.equal(report.banksAdded, 2)
  assert.equal(Object.values(target.state.banks).some((bank) => bank.title === 'keep-me'), false)
  assert.equal(Object.keys(target.state.entries).length, 3)
})

test('旧版裸 state.json 被当作 legacy bundle 接受', () => {
  const { store } = source()
  const parsed = parseBundle(store.toJSON())
  assert.equal(parsed.legacy, true)
  assert.equal(parsed.format, BUNDLE_FORMAT)
  assert.equal(Object.keys(parsed.state.entries).length, 3)
})

test('坏 bundle 给出可诊断的错误码', () => {
  assert.throws(() => parseBundle('{'), /bad-bundle:invalid-json/)
  assert.throws(() => parseBundle({ format: 'other', banks: {}, entries: {} }), /bad-bundle:format/)
  assert.throws(
    () => parseBundle({ format: BUNDLE_FORMAT, version: 99, state: { banks: {}, entries: {} } }),
    /bad-bundle:version/,
  )
  assert.throws(
    () => parseBundle({ format: BUNDLE_FORMAT, version: 2, state: { banks: {}, entries: { entry_x: { id: 'entry_x', bankId: 'b', claim: '' } } } }),
    /bad-bundle:empty-claim/,
  )
})

test('Markdown 投影包含结论、驳回原因与关系', () => {
  const { store } = source()
  const markdown = renderMarkdown(store.toJSON(), { generatedAt: NOW })

  assert.match(markdown, /^# MemStack 记忆库导出/m)
  assert.match(markdown, /## spdk-storage/)
  assert.match(markdown, /### svc\.a/)
  assert.match(markdown, /旧方案：实测不可行/)
  assert.match(markdown, /depends → domain\.b：链路/)
  assert.match(markdown, /已被 `svc\.a` 取代/)
  assert.match(markdown, /标签：perf, nvme/)
})
