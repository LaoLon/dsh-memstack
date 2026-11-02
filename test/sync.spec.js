import test from 'node:test'
import assert from 'node:assert/strict'
import { makeStore, makeWorkspaceStore } from '../test-support/helpers.js'
import { diffSnapshots, hasChanges, renderDiff, snapshotOf } from '../lib/sync.js'

test('快照只包含 active 条目', () => {
  const { store, bankId } = makeWorkspaceStore()
  const first = store.writeEntry({ bankId, topic: 'a.one', kind: 'decision', claim: 'v1' })
  store.writeEntry({ bankId, topic: 'a.one', kind: 'decision', claim: 'v2' })
  store.archiveEntry(first.entry.id)

  const snapshot = snapshotOf(store, [bankId])
  assert.equal(Object.keys(snapshot).length, 1)
  assert.equal(Object.values(snapshot)[0].claim, 'v2')
})

test('diff 能识别新增、更新与废止', () => {
  const { store, bankId } = makeWorkspaceStore()
  store.writeEntry({ bankId, topic: 'keep.one', kind: 'constraint', claim: '保持不变' })
  const changing = store.writeEntry({ bankId, topic: 'change.one', kind: 'decision', claim: '旧结论' })
  const removed = store.writeEntry({ bankId, topic: 'gone.one', kind: 'decision', claim: '将被删除' })
  const before = snapshotOf(store, [bankId])

  store.writeEntry({ bankId, topic: 'change.one', kind: 'decision', claim: '新结论' })
  store.deleteEntry(removed.entry.id)
  const fresh = store.writeEntry({ bankId, topic: 'added.one', kind: 'gotcha', claim: '新踩的坑' })
  const after = snapshotOf(store, [bankId])

  const diff = diffSnapshots(before, after)

  assert.equal(diff.added.length, 1)
  assert.equal(diff.added[0].id, fresh.entry.id)
  assert.equal(diff.updated.length, 1)
  assert.equal(diff.updated[0].after.claim, '新结论')
  assert.equal(diff.removed.length, 1)
  assert.equal(diff.removed[0].topic, 'gone.one')
  assert.ok(hasChanges(diff))
  assert.ok(changing.entry.supersededBy)
})

test('renderDiff 给出驳回记录而不是只报新结论', () => {
  const { store, bankId } = makeWorkspaceStore()
  store.writeEntry({
    bankId,
    topic: 'spdk.ingest-path',
    kind: 'decision',
    claim: '采用 pre_load 注入',
    rejected: [{ option: 'pre_load', reason: '实测拿不到设备句柄' }],
  })
  const before = snapshotOf(store, [bankId])
  store.writeEntry({
    bankId,
    topic: 'spdk.ingest-path',
    kind: 'decision',
    claim: '采用独立守护进程',
    rejected: [{ option: 'pre_load', reason: '实测拿不到设备句柄' }],
  })
  const after = snapshotOf(store, [bankId])

  const text = renderDiff(diffSnapshots(before, after))

  assert.match(text, /记忆更新：spdk\.ingest-path/)
  assert.match(text, /新结论：采用独立守护进程/)
  assert.match(text, /已失效：采用 pre_load 注入/)
  assert.match(text, /不要再建议该方案/)
})

test('库被删除重建后，同一主题不会被报成新增+废止', () => {
  const first = makeStore()
  const bankA = first.ensureWorkspaceBank('ws-a', 'proj').bankId
  first.writeEntry({ bankId: bankA, topic: 'spdk.path', kind: 'decision', claim: '守护进程' })
  const before = snapshotOf(first, [bankA])

  first.deleteBank(bankA)
  const bankB = first.ensureWorkspaceBank('ws-a', 'proj').bankId
  first.writeEntry({ bankId: bankB, topic: 'spdk.path', kind: 'decision', claim: '守护进程' })
  const after = snapshotOf(first, [bankB])

  const diff = diffSnapshots(before, after)
  assert.equal(hasChanges(diff), false, 'identical content after recreation is not a change')

  first.writeEntry({ bankId: bankB, topic: 'spdk.path', kind: 'decision', claim: '改成内核模块' })
  const changed = diffSnapshots(before, snapshotOf(first, [bankB]))
  assert.equal(changed.added.length, 0)
  assert.equal(changed.removed.length, 0)
  assert.equal(changed.updated.length, 1)
  assert.equal(changed.updated[0].after.claim, '改成内核模块')
})

test('归档库不进入快照（因此不会注入，也不会触发变更通知）', () => {
  const { store, bankId } = makeWorkspaceStore()
  store.writeEntry({ bankId, topic: 'public.one', kind: 'decision', claim: '可见结论' })

  const archived = store.createBank({ kind: 'topic', title: '旧库', description: 'x' })
  store.writeEntry({ bankId: archived.id, topic: 'old.one', kind: 'decision', claim: '旧结论' })
  store.archiveBank(archived.id)

  const snapshot = snapshotOf(store, [bankId, archived.id])
  assert.deepEqual(Object.keys(snapshot).map((key) => snapshot[key].topic), ['public.one'])
})

test('仅 pin、详情或时间戳变化不触发通知', () => {
  const { store, bankId } = makeWorkspaceStore()
  const { entry } = store.writeEntry({ bankId, topic: 'pin.one', kind: 'decision', claim: '结论不变' })
  const before = snapshotOf(store, [bankId])

  store.updateEntry(entry.id, { pinned: true, detail: '补一段更详细的说明' })
  const after = snapshotOf(store, [bankId])

  assert.equal(hasChanges(diffSnapshots(before, after)), false)
})

test('结论未变化时 diff 为空', () => {  const { store, bankId } = makeWorkspaceStore()
  store.writeEntry({ bankId, topic: 'x.one', kind: 'decision', claim: '结论' })
  const before = snapshotOf(store, [bankId])
  const after = snapshotOf(store, [bankId])

  assert.equal(hasChanges(diffSnapshots(before, after)), false)
  assert.equal(hasChanges(diffSnapshots({}, {})), false)
})
