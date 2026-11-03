import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../lib/store.js'
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

test('标签被规范化、去重并限制为 8 个', () => {
  const { store, bankId } = makeWorkspaceStore()
  const { entry } = store.writeEntry({
    bankId,
    topic: 'tags.a',
    claim: '带标签的结论',
    tags: [' Perf ', 'NVME', 'perf', 'a', 'b', 'c', 'd', 'e', 'f'],
  })
  assert.deepEqual(entry.tags, ['perf', 'nvme', 'a', 'b', 'c', 'd', 'e', 'f'])
  assert.deepEqual(store.assertInvariants(), [])
})

test('关系可建立、改类型、拒绝自指与非法目标，删除后自动清理', () => {
  const { store, bankId } = makeWorkspaceStore()
  const a = store.writeEntry({ bankId, topic: 'rel.a', claim: 'A' }).entry
  const b = store.writeEntry({ bankId, topic: 'rel.b', claim: 'B' }).entry

  store.relate(a.id, b.id, 'depends', 'A 依赖 B')
  assert.equal(a.relations.length, 1)
  assert.equal(a.relations[0].type, 'depends')
  assert.equal(a.relations[0].note, 'A 依赖 B')

  store.relate(a.id, b.id, 'refines')
  assert.equal(a.relations.length, 1)
  assert.equal(a.relations[0].type, 'refines')

  assert.throws(() => store.relate(a.id, a.id), /self-relation/)
  assert.throws(() => store.relate(a.id, 'entry_missing'), /entry-not-found/)
  assert.throws(() => store.relate(a.id, b.id, 'hates'), /unknown-relation-type/)

  store.deleteEntry(b.id)
  assert.equal(a.relations.length, 0)
  assert.deepEqual(store.assertInvariants(), [])
})

test('复习会重置留存时钟并提高稳定度，且不改变结论', () => {
  const { store, bankId } = makeWorkspaceStore()
  const { entry } = store.writeEntry({ bankId, topic: 'review.a', kind: 'decision', claim: '仍然成立的结论' })
  entry.stabilityDays = 100
  entry.lastReviewedAt = '2025-01-01T00:00:00.000Z'
  entry.reviewCount = 2

  const reviewed = store.reviewEntry(entry.id)
  assert.equal(reviewed.claim, '仍然成立的结论')
  assert.equal(reviewed.stabilityDays, 180)
  assert.equal(reviewed.reviewCount, 3)
  assert.notEqual(reviewed.lastReviewedAt, '2025-01-01T00:00:00.000Z')
  assert.equal(store.assertInvariants().length, 0)
})

test('注入加固只处理 active 条目，并累加召回计数', () => {
  const { store, bankId } = makeWorkspaceStore()
  const fresh = store.writeEntry({ bankId, topic: 'recall.a', claim: 'A' }).entry
  const old = store.writeEntry({ bankId, topic: 'recall.b', claim: 'B' }).entry
  old.lastReviewedAt = '2025-01-01T00:00:00.000Z'
  old.stabilityDays = 30
  const archived = store.writeEntry({ bankId, topic: 'recall.c', claim: 'C' }).entry
  store.archiveEntry(archived.id)

  const count = store.reinforce([fresh.id, old.id, archived.id])
  assert.equal(count, 2)
  assert.equal(fresh.recalledCount, 1)
  assert.equal(old.recalledCount, 1)
  assert.ok(old.stabilityDays > 30)
  assert.equal(archived.recalledCount, 0)
})

test('固定会把稳定度抬到固定下限，取消固定不回落', () => {
  const { store, bankId } = makeWorkspaceStore()
  const { entry } = store.writeEntry({ bankId, topic: 'pin.a', kind: 'decision', claim: 'A' })
  entry.stabilityDays = 10

  store.updateEntry(entry.id, { pinned: true })
  assert.equal(entry.pinned, true)
  assert.equal(entry.stabilityDays, 240)

  store.updateEntry(entry.id, { pinned: false })
  assert.equal(entry.pinned, false)
  assert.equal(entry.stabilityDays, 240)
})

test('归档保留来源状态；被取代的条目不能直接恢复', () => {
  const { store, bankId } = makeWorkspaceStore()
  const first = store.writeEntry({ bankId, topic: 'arch.a', claim: '旧' }).entry
  const second = store.writeEntry({ bankId, topic: 'arch.a', claim: '新' }).entry
  store.archiveEntry(first.id)
  assert.equal(first.status, 'archived')
  assert.equal(first.archivedFrom, 'superseded')
  assert.throws(() => store.restoreEntry(first.id), /superseded-cannot-restore/)

  store.archiveEntry(second.id)
  assert.equal(second.archivedFrom, 'active')
  const restored = store.restoreEntry(second.id)
  assert.equal(restored.status, 'active')
  assert.equal(restored.archivedAt, undefined)
})

test('v1 状态迁移补齐稳定度、标签、关系与计数，且幂等', () => {
  const raw = {
    schemaVersion: 1,
    banks: { bank_x: { id: 'bank_x', kind: 'workspace', title: 'legacy' } },
    entries: {
      entry_x: {
        id: 'entry_x',
        bankId: 'bank_x',
        topic: 'Legacy.Topic',
        kind: 'gotcha',
        claim: '旧条目',
        status: 'superseded',
        supersededBy: 'entry_y',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-02-01T00:00:00.000Z',
      },
      entry_y: {
        id: 'entry_y',
        bankId: 'bank_x',
        topic: 'legacy.other',
        kind: 'decision',
        claim: '新条目',
        supersedes: 'entry_x',
        createdAt: '2025-02-01T00:00:00.000Z',
        updatedAt: '2025-02-01T00:00:00.000Z',
      },
    },
    links: {},
  }
  const store = Store.fromJSON(raw)
  const entry = store.state.entries.entry_x
  assert.equal(entry.stabilityDays, 90)
  assert.equal(entry.topic, 'legacy.topic')
  assert.deepEqual(entry.tags, [])
  assert.deepEqual(entry.relations, [])
  assert.equal(entry.reviewCount, 0)
  assert.equal(entry.recalledCount, 0)
  assert.equal(entry.lastReviewedAt, entry.createdAt)
  assert.equal(entry.supersededAt, entry.updatedAt)
  assert.deepEqual(store.assertInvariants(), [])

  const again = Store.fromJSON(store.toJSON())
  assert.deepEqual(again.state.entries.entry_x, entry)
  assert.deepEqual(again.assertInvariants(), [])
})
