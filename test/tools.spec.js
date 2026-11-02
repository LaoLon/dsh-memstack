import test from 'node:test'
import assert from 'node:assert/strict'
import { makeWorkspaceStore } from '../test-support/helpers.js'
import { memoryTools } from '../lib/tools.js'
import { readEntry, searchEntries, inventory as inventoryOf, forgetEntry } from '../lib/query.js'

function fakeRuntime(store, bankId) {
  return {
    config: {},
    async ready() {},
    get store() {
      return store
    },
    async commit() {},
    async bankFor() {
      return bankId
    },
    search: (query, bank, limit) => searchEntries(store, { query, bank, limit }),
    read: (args) => readEntry(store, args),
    inventory: () => inventoryOf(store, {}),
    forget: (args) => forgetEntry(store, args),
  }
}

function toolByName(tools, name) {
  const tool = tools.find((item) => item.name === name)
  assert.ok(tool, `missing tool ${name}`)
  return tool
}

test('三个工具的定义是可序列化的普通对象', () => {
  const { store, bankId } = makeWorkspaceStore()
  const tools = memoryTools(fakeRuntime(store, bankId))

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['memory_write', 'memory_search', 'memory_read', 'memory_forget', 'memory_inventory'],
  )
  for (const tool of tools) {
    assert.equal(typeof tool.description, 'string')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
    assert.deepEqual(JSON.parse(JSON.stringify(tool.parameters)), tool.parameters)
    assert.deepEqual(JSON.parse(JSON.stringify(tool.output.schema)), tool.output.schema)
  }
})

test('memory_write 写入、取代与去重', async () => {
  const { store, bankId } = makeWorkspaceStore()
  const write = toolByName(memoryTools(fakeRuntime(store, bankId)), 'memory_write')

  const first = await write.execute(
    { topic: 'spdk.ingest-path', kind: 'decision', claim: '采用 pre_load', rejected: [{ option: 'pre_load' }] },
    { agent: { session: { id: 'sess_1' } }, signal: undefined },
  )
  assert.equal(first.result, 'created')
  assert.equal(first.topic, 'spdk.ingest-path')

  const second = await write.execute({ topic: 'SPDK.Ingest-Path', claim: '采用守护进程' }, {})
  assert.equal(second.result, 'superseded')
  assert.equal(second.previous, '采用 pre_load')

  const third = await write.execute({ topic: 'spdk.ingest-path', claim: '采用守护进程' }, {})
  assert.equal(third.result, 'duplicate')
})

test('memory_write 的渲染文本说明发生了什么', async () => {
  const { store, bankId } = makeWorkspaceStore()
  const write = toolByName(memoryTools(fakeRuntime(store, bankId)), 'memory_write')
  await write.execute({ topic: 'a.b', claim: '第一版' }, {})
  const value = await write.execute({ topic: 'a.b', claim: '第二版' }, {})

  const content = write.output.render({}, value)
  assert.equal(content[0].type, 'text')
  assert.match(content[0].text, /已更新 a\.b/)
  assert.match(content[0].text, /旧结论已标记为失效：第一版/)
})

test('memory_search 跨库检索并受 limit 约束', async () => {
  const { store, bankId } = makeWorkspaceStore()
  const other = store.createBank({ kind: 'topic', title: '另一个库', description: 'x' })
  store.writeEntry({ bankId, topic: 'spdk.one', kind: 'decision', claim: '甲' })
  store.writeEntry({ bankId: other.id, topic: 'spdk.two', kind: 'gotcha', claim: '乙' })
  store.writeEntry({ bankId: other.id, topic: 'unrelated.three', kind: 'gotcha', claim: '丙' })

  const tools = memoryTools(fakeRuntime(store, bankId))
  const search = toolByName(tools, 'memory_search')

  const all = await search.execute({ query: 'spdk' }, {})
  assert.equal(all.length, 2)
  const limited = await search.execute({ query: 'spdk', limit: 1 }, {})
  assert.equal(limited.length, 1)
  assert.equal(search.output.render({}, []).length, 1)
})

test('memory_read 读取全文，找不到时抛错', async () => {  const { store, bankId } = makeWorkspaceStore()
  store.writeEntry({
    bankId,
    topic: 'spdk.detail',
    kind: 'constraint',
    claim: '锁定版本',
    detail: '升级会破坏协议',
  })
  const read = toolByName(memoryTools(fakeRuntime(store, bankId)), 'memory_read')

  const value = await read.execute({ topic: 'SPDK.Detail' }, {})
  assert.equal(value.claim, '锁定版本')
  assert.equal(value.detail, '升级会破坏协议')

  await assert.rejects(() => read.execute({ topic: 'missing.topic' }, {}), /not found/)
})

test('memory_forget 删除时恢复被取代的结论', async () => {
  const { store, bankId } = makeWorkspaceStore()
  const tools = memoryTools(fakeRuntime(store, bankId))
  const write = toolByName(tools, 'memory_write')
  const forget = toolByName(tools, 'memory_forget')

  await write.execute({ topic: 'x.y', claim: '第一版' }, {})
  await write.execute({ topic: 'x.y', claim: '第二版' }, {})

  const deleted = await forget.execute({ topic: 'x.y', mode: 'delete' }, {})
  assert.equal(deleted.result, 'deleted')
  assert.equal(deleted.claim, '第二版')
  assert.equal(deleted.restored, '第一版')
  assert.equal(store.findActive(bankId, 'x.y').claim, '第一版')

  const archived = await forget.execute({ topic: 'x.y' }, {})
  assert.equal(archived.result, 'archived')
  assert.equal(store.findActive(bankId, 'x.y'), null)

  await assert.rejects(() => forget.execute({ topic: 'x.y' }, {}), /not found/)
})

test('memory_inventory 给出所有状态并按库分组', async () => {
  const { store, bankId } = makeWorkspaceStore()
  const tools = memoryTools(fakeRuntime(store, bankId))
  const write = toolByName(tools, 'memory_write')
  const inventory = toolByName(tools, 'memory_inventory')

  await write.execute({ topic: 'a.one', claim: '旧' }, {})
  await write.execute({ topic: 'a.one', claim: '新' }, {})
  await write.execute({ topic: 'a.two', claim: '另一条' }, {})

  const rows = await inventory.execute({}, {})
  assert.equal(rows.length, 3)
  assert.equal(rows.filter((row) => row.status === 'superseded').length, 1)
  assert.equal(rows.filter((row) => row.status === 'active').length, 2)

  const text = inventory.output.render({}, rows)[0].text
  assert.match(text, /【MemStack】|【/)
  assert.match(text, /a\.one/)
})
