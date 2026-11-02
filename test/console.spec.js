import test from 'node:test'
import assert from 'node:assert/strict'
import { createConsoleSupervisor, isConsoleAlive } from '../lib/console.js'

function fakeChild() {
  const child = {
    killed: false,
    handlers: {},
    on(event, handler) {
      child.handlers[event] = handler
    },
    kill() {
      child.killed = true
    },
  }
  return child
}

test('停用时不启动任何进程', async () => {
  let spawned = 0
  const supervisor = createConsoleSupervisor({
    enabled: false,
    port: 7788,
    scriptPath: 'server.mjs',
    spawn: () => {
      spawned += 1
      return fakeChild()
    },
    alive: async () => false,
  })

  assert.equal(await supervisor.start(), false)
  assert.equal(spawned, 0)
})

test('端口已有控制台时不重复启动', async () => {
  let spawned = 0
  const supervisor = createConsoleSupervisor({
    enabled: true,
    port: 7788,
    scriptPath: 'server.mjs',
    spawn: () => {
      spawned += 1
      return fakeChild()
    },
    alive: async () => true,
  })

  assert.equal(await supervisor.start(), false)
  assert.equal(spawned, 0)
  supervisor.stop()
})

test('未监听时以 ELECTRON_RUN_AS_NODE 启动子进程并等待就绪', async () => {
  let calls = 0
  const child = fakeChild()
  const captured = {}
  const supervisor = createConsoleSupervisor({
    enabled: true,
    port: 7789,
    scriptPath: 'C:/memstack/console/server.mjs',
    pollIntervalMs: 1,
    spawn(command, args, options) {
      captured.command = command
      captured.args = args
      captured.env = options.env
      return child
    },
    alive: async () => {
      calls += 1
      return calls > 1
    },
  })

  assert.equal(await supervisor.start(), true)
  assert.equal(captured.args[0], 'C:/memstack/console/server.mjs')
  assert.equal(captured.env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(captured.env.MEMSTACK_CONSOLE_PORT, '7789')
  assert.equal(supervisor.owned, true)

  supervisor.stop()
  assert.equal(child.killed, true)
  assert.equal(supervisor.child, null)
})

test('启动后一直没就绪时返回 false 并保留可回收的句柄', async () => {
  const child = fakeChild()
  const warnings = []
  const supervisor = createConsoleSupervisor({
    enabled: true,
    port: 7790,
    scriptPath: 'server.mjs',
    pollIntervalMs: 1,
    attempts: 3,
    logger: { warn: (message) => warnings.push(String(message)) },
    spawn: () => child,
    alive: async () => false,
  })

  assert.equal(await supervisor.start(), false)
  assert.equal(warnings.length, 1)
  supervisor.stop()
  assert.equal(child.killed, true)
})

test('没有启动过子进程时 stop 不做任何事', () => {
  const supervisor = createConsoleSupervisor({
    enabled: true,
    port: 7788,
    scriptPath: 'server.mjs',
    alive: async () => true,
  })
  supervisor.stop()
  assert.equal(supervisor.owned, false)
})

test('isConsoleAlive 对未监听的端口返回 false', async () => {
  assert.equal(await isConsoleAlive(9, 200), false)
})
