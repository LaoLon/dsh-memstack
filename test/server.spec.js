import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../lib/store.js'
import { commitStore, databasePath, getRevision, openHomeDatabase } from '../lib/database.js'
import { APP_VERSION } from '../lib/version.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

async function freePort() {
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

async function waitFor(url) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) return response
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`server did not start: ${url}`)
}

test('console server：状态、写入、复习、关系、图谱、导出与幂等导入', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'memstack-console-'))
  const store = new Store()
  const { bankId } = store.ensureWorkspaceBank('ws-test', 'test-bank')
  store.writeEntry({ bankId, topic: 'seed.topic', kind: 'decision', claim: '种子结论' })
  const db = openHomeDatabase(home)
  try {
    commitStore(db, store, { expectedRevision: getRevision(db) })
  } finally {
    db.close()
  }

  const port = await freePort()
  const child = spawn(process.execPath, [join(ROOT, 'console', 'server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, MEMSTACK_HOME: home, MEMSTACK_CONSOLE_PORT: String(port) },
    stdio: 'ignore',
  })
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill()
      await new Promise((resolve) => child.once('exit', resolve))
    }
    await rm(home, { recursive: true, force: true })
  })

  const base = `http://127.0.0.1:${port}`
  await waitFor(`${base}/api/health`)

  const health = await (await fetch(`${base}/api/health`)).json()
  assert.equal(health.ok, true)
  assert.equal(health.homeDir, home)
  assert.equal(health.storage, 'sqlite')
  assert.equal(health.dbFile, databasePath(home))
  assert.equal(health.version, APP_VERSION)

  const state = await (await fetch(`${base}/api/state`)).json()
  assert.equal(state.banks.length, 1)
  assert.equal(state.entries.length, 1)
  assert.equal(state.entries[0].topic, 'seed.topic')
  assert.equal(typeof state.entries[0].retention, 'number')

  const staticResponse = await fetch(`${base}/app.js`)
  assert.equal(staticResponse.status, 200)
  assert.match(await staticResponse.text(), /createGraphView/)

  const created = await (
    await fetch(`${base}/api/entry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        bankId,
        topic: 'console.utf8',
        kind: 'gotcha',
        claim: '中文结论：不要用 UTF-16 写 JSON',
        detail: '控制台必须保留中文',
        tags: ['编码', 'json'],
        rejected: [{ option: 'UTF-16', reason: '解析失败' }],
      }),
    })
  ).json()
  const added = created.entries.find((entry) => entry.topic === 'console.utf8')
  assert.ok(added)
  assert.equal(added.claim, '中文结论：不要用 UTF-16 写 JSON')
  assert.deepEqual(added.tags, ['编码', 'json'])

  const reviewed = await (
    await fetch(`${base}/api/entry/${added.id}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
  ).json()
  const reviewedEntry = reviewed.entries.find((entry) => entry.id === added.id)
  assert.equal(reviewedEntry.retention, 1)
  assert.equal(reviewedEntry.reviewCount, 1)

  const related = await (
    await fetch(`${base}/api/entry/${added.id}/relate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: state.entries[0].id, type: 'refines' }),
    })
  ).json()
  const relatedEntry = related.entries.find((entry) => entry.id === added.id)
  assert.equal(relatedEntry.relations[0].target, state.entries[0].id)

  const graph = await (await fetch(`${base}/api/graph`)).json()
  assert.equal(graph.nodes.filter((node) => node.type === 'entry').length, 2)
  assert.ok(graph.edges.some((edge) => edge.type === 'relation'))

  const bundleResponse = await fetch(`${base}/api/export?format=json`)
  const bundle = await bundleResponse.json()
  assert.equal(bundle.format, 'memstack.bundle')
  assert.equal(bundle.stats.entries, 2)

  const markdown = await (await fetch(`${base}/api/export?format=markdown`)).text()
  assert.match(markdown, /中文结论/)

  const imported = await (
    await fetch(`${base}/api/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bundle, mode: 'merge' }),
    })
  ).json()
  assert.equal(imported.report.entriesAdded, 0)
  assert.equal(imported.report.entriesSkipped, 2)
  assert.equal(imported.entries.length, 2)
  assert.match(imported.backup, /memstack\.db\.[\dT]+\.bak$/)
  assert.equal(existsSync(imported.backup), true)

  const bad = await fetch(`${base}/api/entry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bankId, topic: '', claim: '' }),
  })
  assert.equal(bad.status, 400)
  assert.match((await bad.json()).error, /empty-/)
})
