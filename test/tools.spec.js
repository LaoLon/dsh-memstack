import test from 'node:test'
import assert from 'node:assert/strict'
import { makeWorkspaceStore } from '../test-support/helpers.js'
import { memoryTools } from '../lib/tools.js'
import { readEntry, resolveEntry, searchEntries, inventory as inventoryOf, forgetEntry } from '../lib/query.js'

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
    async review(args) {
      const entry = resolveEntry(store, { ...args, includeInactive: false })
      if (!entry) return null
      if (args.verdict === 'outdated') {
        store.archiveEntry(entry.id)
        return { result: 'archived', topic: entry.topic, claim: entry.claim }
      }
      store.reviewEntry(entry.id)
      return { result: 'reviewed', topic: entry.topic, claim: entry.claim, retention: 1, stage: 'fresh' }
    },
    async relate({ from, to, type, note, remove }) {
      const source = resolveEntry(store, { ...from, includeInactive: true })
      const target = resolveEntry(store, { ...to, includeInactive: true })
      if (!source || !target) return null
      if (remove) store.unrelate(source.id, target.id)
      else store.relate(source.id, target.id, type ?? 'related', note ?? '')
      return {
        from: { id: source.id, topic: source.topic },
        to: { id: target.id, topic: target.topic },
        type: type ?? 'related',
        removed: Boolean(remove),
      }
    },
  }
}

function toolByName(tools, name) {
  const tool = tools.find((item) => item.name === name)
  assert.ok(tool, `missing tool ${name}`)
  return tool
}

test('工具的定义是可序列化的普通对象', () => {
  const { store, bankId } = makeWorkspaceStore()
  const tools = memoryTools(fakeRuntime(store, bankId))

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ['memory_write', 'memory_search', 'memory_read', 'memory_forget', 'memory_review', 'memory_relate', 'memory_inventory'],
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

test('memory_review 确认后重置留存，过时则停用', async () => {
  const { store, bankId } = makeWorkspaceStore()
  const tools = memoryTools(fakeRuntime(store, bankId))
  const write = toolByName(tools, 'memory_write')
  const review = toolByName(tools, 'memory_review')

  await write.execute({ topic: 'review.me', kind: 'decision', claim: '仍然成立' }, {})
  const entry = store.findActive(bankId, 'review.me')
  entry.stabilityDays = 30
  entry.lastReviewedAt = '2025-01-01T00:00:00.000Z'
  entry.reviewCount = 0

  const reviewed = await review.execute({ topic: 'review.me', verdict: 'still-true' }, {})
  assert.equal(reviewed.result, 'reviewed')
  assert.equal(reviewed.claim, '仍然成立')
  assert.equal(reviewed.retention, 1)
  assert.equal(entry.reviewCount, 1)
  assert.equal(entry.stabilityDays, 54)
  assert.match(review.output.render({}, reviewed)[0].text, /已复习 review\.me/)

  const archived = await review.execute({ id: entry.id, verdict: 'outdated' }, {})
  assert.equal(archived.result, 'archived')
  assert.equal(entry.status, 'archived')
  assert.match(review.output.render({}, archived)[0].text, /已停用/)
  await assert.rejects(() => review.execute({ topic: 'review.me', verdict: 'still-true' }, {}), /not found/)
})

test('memory_relate 建立与移除关系，并拒绝不存在的目标', async () => {
  const { store, bankId } = makeWorkspaceStore()
  const tools = memoryTools(fakeRuntime(store, bankId))
  const write = toolByName(tools, 'memory_write')
  const relate = toolByName(tools, 'memory_relate')

  await write.execute({ topic: 'rel.source', claim: '源结论' }, {})
  await write.execute({ topic: 'rel.target', claim: '目标结论' }, {})

  const created = await relate.execute(
    { source: 'rel.source', target: 'rel.target', type: 'refines', note: '更细' },
    {},
  )
  assert.deepEqual(created, { from: 'rel.source', to: 'rel.target', type: 'refines', removed: false })
  const source = store.findActive(bankId, 'rel.source')
  assert.equal(source.relations[0].target, store.findActive(bankId, 'rel.target').id)
  assert.equal(source.relations[0].note, '更细')
  assert.match(relate.output.render({}, created)[0].text, /已建立关系：rel\.source —refines→ rel\.target/)

  const removed = await relate.execute({ source: 'rel.source', target: 'rel.target', remove: true }, {})
  assert.equal(removed.removed, true)
  assert.equal(source.relations.length, 0)
  assert.match(relate.output.render({}, removed)[0].text, /已移除关系/)

  await assert.rejects(() => relate.execute({ source: 'rel.source', target: 'rel.missing' }, {}), /not found/)
})

test('memory_read 展示关系与取代链，memory_search 标注留存阶段', async () => {
  const { store, bankId } = makeWorkspaceStore()
  const tools = memoryTools(fakeRuntime(store, bankId))
  const write = toolByName(tools, 'memory_write')
  const read = toolByName(tools, 'memory_read')
  const search = toolByName(tools, 'memory_search')
  const relate = toolByName(tools, 'memory_relate')

  await write.execute({ topic: 'chain.x', claim: '第一版' }, {})
  await write.execute({ topic: 'chain.x', claim: '第二版' }, {})
  await write.execute({ topic: 'chain.y', claim: '相关结论', tags: ['chain'] }, {})
  await relate.execute({ source: 'chain.x', target: 'chain.y', type: 'related' }, {})

  const view = await read.execute({ topic: 'chain.x' }, {})
  assert.equal(view.claim, '第二版')
  assert.equal(view.status, 'active')
  assert.equal(view.chain.length, 2)
  assert.equal(view.relations[0].target.topic, 'chain.y')
  assert.equal(typeof view.retention, 'number')

  const rows = await search.execute({ query: 'chain' }, {})
  assert.ok(rows.length >= 2)
  assert.ok(rows.every((row) => typeof row.retention === 'number' && row.stage))
  assert.match(search.output.render({ query: 'chain' }, rows)[0].text, /留存/)
})

/**
 * The Host validates every tool result against `output.schema` with
 * `additionalProperties: false`, so a field the implementation returns but the
 * schema forgot rejects the whole call at runtime. That is exactly how
 * `memory_inventory` broke on 2026-11-03, so the drift is checked here instead
 * of being discovered by a live session.
 */
function assertConforms(schema, value, path) {
  if (schema.type === 'object') {
    assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${path} should be an object`)
    for (const key of schema.required ?? []) assert.ok(key in value, `${path}.${key} is required but missing`)
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}))
      for (const key of Object.keys(value)) assert.ok(allowed.has(key), `${path}.${key} is returned but not declared in the schema`)
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (value[key] !== undefined) assertConforms(sub, value[key], `${path}.${key}`)
    }
    return
  }
  if (schema.type === 'array') {
    assert.ok(Array.isArray(value), `${path} should be an array`)
    if (schema.items) value.forEach((item, index) => assertConforms(schema.items, item, `${path}[${index}]`))
    return
  }
  if (schema.enum) assert.ok(schema.enum.includes(value), `${path}=${value} is outside the declared enum`)
  if (schema.type === 'string') assert.equal(typeof value, 'string', `${path} should be a string`)
  if (schema.type === 'number') assert.equal(typeof value, 'number', `${path} should be a number`)
  if (schema.type === 'boolean') assert.equal(typeof value, 'boolean', `${path} should be a boolean`)
}

test('每个工具的返回值都符合它自己声明的输出 schema', async () => {
  const { store, bankId } = makeWorkspaceStore()
  store.writeEntry({ bankId, topic: 'conf.other', kind: 'gotcha', claim: '另一条用于关系验证' })
  const tools = memoryTools(fakeRuntime(store, bankId))

  const calls = {
    memory_write: { topic: 'conf.write', claim: '输出与 schema 一致', kind: 'decision', tags: ['conformance'], rejected: [{ option: '不测', reason: '宿主会拒绝非法输出' }] },
    memory_search: { query: 'conf' },
    memory_read: { topic: 'conf.write' },
    memory_forget: { topic: 'conf.other', mode: 'archive' },
    memory_review: { topic: 'conf.write', verdict: 'still-true' },
    memory_relate: { source: 'conf.write', target: 'conf.other', type: 'related' },
    memory_inventory: {},
  }

  for (const tool of tools) {
    const args = calls[tool.name]
    assert.ok(args, `${tool.name} 缺少一致性测试入参`)
    const value = await tool.execute(args, {})
    assertConforms(tool.output.schema, value, tool.name)
  }
})
