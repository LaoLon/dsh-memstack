import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { registerInjection } from '../lib/inject.js'
import { makeStore } from '../test-support/helpers.js'

function fakeSession() {
  const events = new Map()
  const session = {
    id: 'sess_test',
    events,
    surface: { nodes: [] },
    eventAt(seq) {
      return events.get(seq)
    },
    record(message) {
      const seq = session.surface.nodes.length + 1
      session.surface.nodes.push(seq)
      events.set(seq, { type: 'user/message', data: message })
    },
  }
  return session
}

function fakeContext(services, registrations) {
  return {
    logger: { warn() {} },
    effect(fn) {
      return fn()
    },
    get(name) {
      return services[name]
    },
    on(name, handler) {
      registrations.handlers.set(name, handler)
      return () => {}
    },
    tools: {
      register(tool) {
        registrations.tools.push(tool)
        return () => {}
      },
    },
  }
}

async function bootstrap() {
  const home = await mkdtemp(join(tmpdir(), 'memstack-test-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const session = fakeSession()
  const registrations = { tools: [], handlers: new Map(), sections: [] }
  const ctx = fakeContext(
    {
      workingDirectory: { ensure: async () => 'E:\\Code\\MemStack' },
      systemPrompt: { section: (definition) => () => definition },
    },
    registrations,
  )
  apply(ctx, {})
  const preStep = registrations.handlers.get('agent/pre-step')
  assert.ok(preStep, 'agent/pre-step handler must be registered')

  return {
    ctx,
    session,
    registrations,
    async step(messages = []) {
      const decision = { kind: 'continue', messages: [...messages] }
      return preStep({ agent: { session }, messages: [...messages], step: 1, signal: undefined }, async () => decision)
    },
    async write(args) {
      const tool = registrations.tools.find((item) => item.name === 'memory_write')
      assert.ok(tool, 'memory_write must be registered')
      return tool.execute(args, { agent: { session }, signal: undefined })
    },
    async cleanup() {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      await rm(home, { recursive: true, force: true })
    },
  }
}

test('插件装载：注册三个工具、一条静态规则与 pre-step 监听', async () => {
  const { registrations, cleanup } = await bootstrap()
  try {
    assert.deepEqual(
      registrations.tools.map((tool) => tool.name),
      ['memory_write', 'memory_search', 'memory_read', 'memory_forget', 'memory_inventory'],
    )
    assert.ok(registrations.handlers.has('agent/pre-step'))
  } finally {
    await cleanup()
  }
})

test('空库不注入任何消息', async () => {
  const { step, cleanup } = await bootstrap()
  try {
    const decision = await step([])
    assert.equal(decision.messages.length, 0)
  } finally {
    await cleanup()
  }
})

test('首次写入后注入索引，且同一会话只注入一次', async () => {
  const { session, step, write, cleanup } = await bootstrap()
  try {
    await write({
      topic: 'spdk.ingest-path',
      kind: 'decision',
      claim: '采用独立守护进程读取设备',
      rejected: [{ option: 'pre_load 注入', reason: '目标时机拿不到设备句柄' }],
    })

    const first = await step([])
    assert.equal(first.messages.length, 1)
    const message = first.messages[0]
    assert.equal(message.role, 'user')
    assert.equal(message.source.kind, 'memstack')
    assert.equal(message.source.baseline, true)
    const text = message.content[0].text
    assert.match(text, /spdk\.ingest-path/)
    assert.match(text, /已否决：pre_load 注入/)
    assert.match(text, /<system-reminder>[\s\S]*<\/system-reminder>/)

    session.record(message)

    const second = await step([])
    assert.equal(second.messages.length, 0, 'no change means no reinjection')
  } finally {
    await cleanup()
  }
})

test('结论被推翻时注入驳回通知，而不是新索引', async () => {
  const { session, step, write, cleanup } = await bootstrap()
  try {
    await write({
      topic: 'spdk.ingest-path',
      claim: '采用 pre_load 注入',
      rejected: [{ option: 'pre_load', reason: '实测拿不到设备句柄' }],
    })
    const baseline = await step([])
    session.record(baseline.messages[0])

    await write({
      topic: 'spdk.ingest-path',
      claim: '采用独立守护进程',
      rejected: [{ option: 'pre_load', reason: '实测拿不到设备句柄' }],
    })

    const update = await step([])
    assert.equal(update.messages.length, 1)
    const text = update.messages[0].content[0].text
    assert.match(text, /记忆更新：spdk\.ingest-path/)
    assert.match(text, /新结论：采用独立守护进程/)
    assert.match(text, /已失效：采用 pre_load 注入/)
    assert.match(text, /不要再建议该方案/)
    assert.equal(update.messages[0].source.baseline, false)
  } finally {
    await cleanup()
  }
})

test('外部修改 state.json 后，下一次工具调用会重新加载', async () => {
  const { registrations, write, cleanup } = await bootstrap()
  try {
    await write({ topic: 'ext.one', claim: '会被外部归档的结论' })
    const search = registrations.tools.find((tool) => tool.name === 'memory_search')
    assert.equal((await search.execute({ query: 'ext' }, {})).length, 1)

    // Simulate the local console editing the file behind the Host's back.
    await new Promise((resolve) => setTimeout(resolve, 20))
    const file = join(process.env.DSH_HOME, 'memstack', 'state.json')
    const { readFile, writeFile } = await import('node:fs/promises')
    const raw = JSON.parse(await readFile(file, 'utf8'))
    for (const entry of Object.values(raw.entries)) entry.status = 'archived'
    await writeFile(file, JSON.stringify(raw), 'utf8')

    assert.equal((await search.execute({ query: 'ext' }, {})).length, 0, 'archived entry must disappear')
  } finally {
    await cleanup()
  }
})

test('删除条目后注入废止通知', async () => {
  const store = makeStore()
  const { bankId } = store.ensureWorkspaceBank('ws-delete', 'proj')
  const runtime = {
    config: { injectIndex: true, indexByteBudget: 4096, recallTopK: 40, discoverabilityBudget: 512 },
    async ready() {},
    get store() {
      return store
    },
    async recallBankIds() {
      return [bankId]
    },
  }
  const registrations = { tools: [], handlers: new Map(), sections: [] }
  const ctx = fakeContext({ workingDirectory: { ensure: async () => 'E:\\proj' } }, registrations)
  registerInjection(ctx, runtime)
  const preStep = registrations.handlers.get('agent/pre-step')
  const session = fakeSession()
  const step = async () => {
    const decision = { kind: 'continue', messages: [] }
    return preStep({ agent: { session }, messages: [], step: 1, signal: undefined }, async () => decision)
  }

  const { entry } = store.writeEntry({ bankId, topic: 'gone.topic', kind: 'decision', claim: '将被删除' })
  const baseline = await step()
  session.record(baseline.messages[0])

  store.deleteEntry(entry.id)
  const notice = await step()

  assert.equal(notice.messages.length, 1)
  assert.match(notice.messages[0].content[0].text, /记忆废止：gone\.topic/)
})
