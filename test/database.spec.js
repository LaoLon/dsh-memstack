import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../lib/store.js'
import {
  backupDatabase,
  commitStore,
  databasePath,
  getRevision,
  legacyStatePath,
  loadStore,
  openHomeDatabase,
  StoreDatabase,
} from '../lib/database.js'

async function tempHome() {
  return mkdtemp(join(tmpdir(), 'memstack-db-'))
}

async function cleanup(home) {
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
}

function seedStore() {
  const store = new Store()
  const { bankId } = store.ensureWorkspaceBank('ws-db', '数据库测试')
  const first = store.writeEntry({
    bankId,
    topic: 'db.first',
    kind: 'decision',
    claim: '先写 JSON',
    tags: ['存储'],
  })
  const second = store.writeEntry({
    bankId,
    topic: 'db.first',
    kind: 'decision',
    claim: '改用 SQLite',
    tags: ['存储'],
    rejected: [{ option: '继续 JSON', reason: '每次全量重写' }],
  })
  store.relate(second.entry.id, first.entry.id, 'refines', '替代关系')
  const other = store.createBank({ kind: 'topic', title: '另一库' })
  store.link(bankId, other.id, { recall: true })
  return { store, bankId, otherId: other.id, firstId: first.entry.id, secondId: second.entry.id }
}

test('SQLite 往返：库、条目、关系、库关联与不变量保持一致', async () => {
  const home = await tempHome()
  try {
    const { store, bankId, otherId, secondId, firstId } = seedStore()
    const db = openHomeDatabase(home)
    assert.equal(getRevision(db), 0)
    assert.equal(commitStore(db, store, { expectedRevision: 0 }), 1)
    assert.equal(store.dirty.all, false)
    assert.equal(store.dirty.entries.size, 0)
    db.close()

    const reopened = openHomeDatabase(home)
    const loaded = loadStore(reopened)
    assert.equal(getRevision(reopened), 1)
    assert.deepEqual(loaded.assertInvariants(), [])
    assert.equal(Object.keys(loaded.state.entries).length, 2)
    assert.equal(loaded.state.entries[secondId].claim, '改用 SQLite')
    assert.equal(loaded.state.entries[firstId].status, 'superseded')
    assert.equal(loaded.state.entries[secondId].relations[0].type, 'refines')
    assert.equal(loaded.state.links[`${bankId}->${otherId}`].recall, true)
    reopened.close()
  } finally {
    await cleanup(home)
  }
})

test('增量写入只更新脏行，删除库会级联清掉条目与关联', async () => {
  const home = await tempHome()
  try {
    const { store, bankId, otherId, secondId } = seedStore()
    const db = openHomeDatabase(home)
    commitStore(db, store, { expectedRevision: 0 })

    store.updateEntry(secondId, { claim: '只改这一条', pinned: true })
    assert.deepEqual([...store.dirty.entries], [secondId])
    assert.equal(store.dirty.banks.size, 0)
    commitStore(db, store, { expectedRevision: 1 })
    assert.equal(loadStore(db).state.entries[secondId].claim, '只改这一条')

    // The removed entry and bank must disappear without a full-table rewrite.
    store.deleteBank(otherId)
    commitStore(db, store, { expectedRevision: 2 })
    assert.equal(loadStore(db).state.banks[otherId], undefined)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM links').get().n, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM entries WHERE bank_id = ?').get(otherId).n, 0)
    assert.deepEqual(loadStore(db).assertInvariants(), [])
    db.close()
  } finally {
    await cleanup(home)
  }
})

test('混合领域操作后的增量提交与内存快照一致', async () => {
  const home = await tempHome()
  try {
    const { store, bankId, otherId, firstId, secondId } = seedStore()
    const db = openHomeDatabase(home)
    commitStore(db, store, { expectedRevision: 0 })

    store.updateEntry(secondId, { detail: '补充说明', pinned: true, tags: ['sqlite', '迁移'] })
    store.relate(secondId, firstId, 'contradicts', '测试关系')
    store.unrelate(secondId, firstId)
    store.archiveEntry(secondId)
    store.restoreEntry(secondId)
    store.archiveBank(otherId)
    store.restoreBank(otherId)
    store.unlink(bankId, otherId)
    store.link(bankId, otherId, { recall: false, query: false })
    const extra = store.writeEntry({ bankId, topic: 'db.extra', kind: 'gotcha', claim: '增量提交也要一致' })
    store.deleteEntry(extra.entry.id)
    commitStore(db, store, { expectedRevision: 1 })

    const loaded = loadStore(db)
    db.close()
    assert.deepEqual(loaded.toJSON(), JSON.parse(JSON.stringify(store.toJSON())))
    assert.deepEqual(loaded.assertInvariants(), [])
  } finally {
    await cleanup(home)
  }
})

test('并发提交使用 revision 检测冲突，不静默覆盖对方', async () => {
  const home = await tempHome()
  try {
    const dbA = openHomeDatabase(home)
    const storeA = loadStore(dbA)
    const revision = getRevision(dbA)
    const dbB = openHomeDatabase(home)
    const storeB = loadStore(dbB)

    storeA.createBank({ kind: 'topic', title: 'A 的库' })
    assert.equal(commitStore(dbA, storeA, { expectedRevision: revision }), revision + 1)

    storeB.createBank({ kind: 'topic', title: 'B 的库' })
    assert.throws(
      () => commitStore(dbB, storeB, { expectedRevision: revision }),
      /state-conflict:/,
    )
    assert.equal(getRevision(dbB), revision + 1)
    assert.equal(Object.values(loadStore(dbB).state.banks).some((bank) => bank.title === 'B 的库'), false)
    assert.equal(storeB.dirty.banks.size, 1, 'failed commit keeps local changes marked dirty')
    dbA.close()
    dbB.close()
  } finally {
    await cleanup(home)
  }
})

test('首次打开时把旧 state.json 导入 SQLite 并改名备份', async () => {
  const home = await tempHome()
  try {
    const { store } = seedStore()
    await mkdir(join(home, 'memstack'), { recursive: true })
    const legacy = legacyStatePath(home)
    await writeFile(legacy, JSON.stringify(store.toJSON()), 'utf8')

    const db = openHomeDatabase(home)
    const loaded = loadStore(db)
    assert.equal(Object.keys(loaded.state.entries).length, 2)
    assert.equal(Object.values(loaded.state.entries).find((entry) => entry.status === 'active').claim, '改用 SQLite')
    assert.equal(existsSync(legacy), false)
    assert.equal(existsSync(databasePath(home)), true)
    const files = await readdir(join(home, 'memstack'))
    const backup = files.find((name) => name.startsWith('state.json.migrated-') && name.endsWith('.bak'))
    assert.ok(backup, 'legacy JSON must be renamed, not deleted')
    assert.equal(JSON.parse(await readFile(join(home, 'memstack', backup), 'utf8')).entries && true, true)
    db.close()

    // A second open must not import the backup again.
    const again = openHomeDatabase(home)
    assert.equal(getRevision(again), 1)
    again.close()

    // Even if a stale state.json reappears, an existing database wins.
    await writeFile(legacy, JSON.stringify(store.toJSON()), 'utf8')
    const stale = openHomeDatabase(home)
    assert.equal(getRevision(stale), 1)
    assert.equal(Object.keys(loadStore(stale).state.entries).length, 2)
    assert.equal(existsSync(legacy), true)
    stale.close()
  } finally {
    await cleanup(home)
  }
})

test('损坏的旧 JSON 不会留下空数据库，也不会吞掉数据', async () => {
  const home = await tempHome()
  try {
    await mkdir(join(home, 'memstack'), { recursive: true })
    await writeFile(legacyStatePath(home), '{ not json', 'utf8')
    assert.throws(() => openHomeDatabase(home), /legacy-migration-failed:/)
    assert.equal(existsSync(databasePath(home)), false)
    assert.equal(existsSync(legacyStatePath(home)), true)
  } finally {
    await cleanup(home)
  }
})

test('备份是完整可读的数据库，且不随后续写入变化', async () => {
  const home = await tempHome()
  try {
    const { store } = seedStore()
    const db = openHomeDatabase(home)
    commitStore(db, store, { expectedRevision: 0 })
    const backupFile = join(home, 'backup.db')
    await backupDatabase(db, backupFile)

    const active = Object.values(store.state.entries).find((entry) => entry.status === 'active')
    store.updateEntry(active.id, { claim: '备份之后的修改' })
    commitStore(db, store, { expectedRevision: 1 })

    const copy = new DatabaseSync(backupFile, { readOnly: true })
    const restored = loadStore(copy)
    assert.equal(restored.state.entries[active.id].claim, '改用 SQLite')
    assert.equal(Object.keys(restored.state.entries).length, 2)
    assert.deepEqual(restored.assertInvariants(), [])
    copy.close()
    db.close()
  } finally {
    await cleanup(home)
  }
})

test('StoreDatabase 会缓存快照、感知外部提交并回滚失败的事务', async () => {
  const home = await tempHome()
  try {
    const database = new StoreDatabase(home)
    const first = await database.mutate((store) => {
      store.ensureWorkspaceBank('ws-cache', '缓存测试')
    })
    assert.equal(getRevision(database.db), 1)
    assert.equal(Object.keys(first.store.state.banks).length, 1)

    const external = openHomeDatabase(home)
    const outside = loadStore(external)
    outside.createBank({ kind: 'topic', title: '外部库' })
    commitStore(external, outside, { expectedRevision: 1 })
    external.close()

    assert.equal(Object.values(database.readStore().state.banks).some((bank) => bank.title === '外部库'), true)
    const revision = database.revision
    await assert.rejects(
      database.mutate((store) => {
        store.createBank({ kind: 'topic', title: '回滚库' })
        throw new Error('boom')
      }),
      /boom/,
    )
    assert.equal(database.revision, revision)
    assert.equal(Object.values(database.readStore().state.banks).some((bank) => bank.title === '回滚库'), false)
    database.close()
  } finally {
    await cleanup(home)
  }
})
