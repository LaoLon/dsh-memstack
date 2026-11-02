import test from 'node:test'
import assert from 'node:assert/strict'
import { makeStore, makeWorkspaceStore, seededRandom } from '../test-support/helpers.js'

test('T1 同 topic 再次写入会取代旧条目并保持双向链接', () => {
  const { store, bankId } = makeWorkspaceStore()
  const first = store.writeEntry({
    bankId,
    topic: 'spdk.ingest-path',
    kind: 'decision',
    claim: '采用 pre_load 注入方案',
    rejected: [{ option: 'pre_load', reason: '尚未验证' }],
  })
  const second = store.writeEntry({
    bankId,
    topic: 'SPDK.Ingest_Path',
    kind: 'decision',
    claim: '采用独立守护进程读取设备',
    rejected: [{ option: 'pre_load 注入', reason: '目标时机拿不到设备句柄' }],
  })

  assert.equal(first.result, 'created')
  assert.equal(second.result, 'superseded')
  assert.equal(second.entry.topic, 'spdk.ingest-path')
  assert.equal(first.entry.status, 'superseded')
  assert.equal(first.entry.supersededBy, second.entry.id)
  assert.equal(second.entry.supersedes, first.entry.id)
  assert.equal(store.listEntries(bankId, { status: 'active' }).length, 1)
  assert.deepEqual(store.assertInvariants(), [])
})

test('T2 完全相同的写入判定为 duplicate，不新增条目', () => {
  const { store, bankId } = makeWorkspaceStore()
  const input = {
    bankId,
    topic: 'spdk.dpdk-version',
    kind: 'constraint',
    claim: '锁定 23.11，不要升级',
    detail: '升级会破坏共享内存协议',
  }
  store.writeEntry(input)
  const again = store.writeEntry(input)

  assert.equal(again.result, 'duplicate')
  assert.equal(Object.keys(store.toJSON().entries).length, 1)
  assert.deepEqual(store.assertInvariants(), [])
})

test('T3 删除取代者会把前驱恢复为 active', () => {
  const { store, bankId } = makeWorkspaceStore()
  const first = store.writeEntry({ bankId, topic: 'spdk.ingest-path', kind: 'decision', claim: '用 pre_load' })
  const second = store.writeEntry({ bankId, topic: 'spdk.ingest-path', kind: 'decision', claim: '用守护进程' })

  const { restored } = store.deleteEntry(second.entry.id)

  assert.equal(restored.id, first.entry.id)
  assert.equal(store.getEntry(first.entry.id).status, 'active')
  assert.equal(store.getEntry(first.entry.id).supersededBy, undefined)
  assert.deepEqual(store.assertInvariants(), [])
})

test('T3b 删除没有前驱的条目后库里不留残留', () => {
  const { store, bankId } = makeWorkspaceStore()
  const only = store.writeEntry({ bankId, topic: 'a.b', kind: 'gotcha', claim: '踩过的坑' })
  const { restored } = store.deleteEntry(only.entry.id)

  assert.equal(restored, null)
  assert.equal(store.listEntries(bankId).length, 0)
  assert.deepEqual(store.assertInvariants(), [])
})

test('T3c 删除链中节点会重新接线，不留悬空引用', () => {
  const { store, bankId } = makeWorkspaceStore()
  const first = store.writeEntry({ bankId, topic: 'chain.topic', kind: 'decision', claim: 'v1' })
  const second = store.writeEntry({ bankId, topic: 'chain.topic', kind: 'decision', claim: 'v2' })
  const third = store.writeEntry({ bankId, topic: 'chain.topic', kind: 'decision', claim: 'v3' })

  store.deleteEntry(second.entry.id)

  assert.equal(store.getEntry(first.entry.id).supersededBy, third.entry.id)
  assert.equal(store.getEntry(third.entry.id).supersedes, first.entry.id)
  assert.deepEqual(store.assertInvariants(), [])
})

test('T8 随机操作序列后不变量仍然成立', () => {
  const store = makeStore()
  const random = seededRandom(20261021)
  const pick = (list) => list[Math.floor(random() * list.length)]
  const topics = ['a.one', 'a.two', 'b.one']
  const bankIds = []

  for (let step = 0; step < 400; step += 1) {
    try {
      const roll = random()
      if (roll < 0.15 || bankIds.length === 0) {
        const bank = store.createBank({ kind: 'topic', title: `bank-${step}`, description: 'x' })
        bankIds.push(bank.id)
      } else if (roll < 0.6) {
        store.writeEntry({
          bankId: pick(bankIds),
          topic: pick(topics),
          kind: pick(['decision', 'constraint', 'gotcha']),
          claim: `claim-${step}`,
        })
      } else if (roll < 0.75) {
        const entries = Object.values(store.toJSON().entries)
        if (entries.length) store.archiveEntry(pick(entries).id)
      } else if (roll < 0.85) {
        const entries = Object.values(store.toJSON().entries)
        if (entries.length) store.restoreEntry(pick(entries).id)
      } else if (roll < 0.95) {
        const entries = Object.values(store.toJSON().entries)
        if (entries.length) store.deleteEntry(pick(entries).id)
      } else if (bankIds.length > 1) {
        store.link(pick(bankIds), pick(bankIds), { recall: random() > 0.5 })
      }
    } catch {
      // Expected domain errors (topic taken, self link) are part of the sequence.
    }
  }

  assert.deepEqual(store.assertInvariants(), [])
})

test('工作区库惰性创建且稳定复用', () => {  const store = makeStore()
  const first = store.ensureWorkspaceBank('ws-a', 'project-a')
  const second = store.ensureWorkspaceBank('ws-a', 'project-a')
  const other = store.ensureWorkspaceBank('ws-b', 'project-b')

  assert.equal(first.created, true)
  assert.equal(second.created, false)
  assert.equal(second.bankId, first.bankId)
  assert.notEqual(other.bankId, first.bankId)
})

test('删除工作区库会清掉默认库映射，重建时得到新库', () => {
  const store = makeStore()
  const first = store.ensureWorkspaceBank('ws-a', 'project-a')
  assert.equal(store.toJSON().meta.defaultBankByWorkspace['ws-a'], first.bankId)

  store.deleteBank(first.bankId)
  assert.equal(store.toJSON().meta.defaultBankByWorkspace['ws-a'], undefined)

  const again = store.ensureWorkspaceBank('ws-a', 'project-a')
  assert.equal(again.created, true)
  assert.notEqual(again.bankId, first.bankId)
})
