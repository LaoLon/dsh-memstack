/** MemStack console: local read/write HTTP view over $DSH_HOME/memstack/state.json. No DSH APIs. */

import { createServer } from 'node:http'
import { copyFile, readFile, stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Store, RELATION_TYPES } from '../lib/store.js'
import { buildGraph, summarize } from '../lib/graph.js'
import { describeDecay, KIND_STABILITY } from '../lib/decay.js'
import { entryView, reviewQueue, visibleBanks } from '../lib/query.js'
import {
  buildBundle,
  importState,
  parseBundle,
  renderMarkdown,
  serializeBundle,
} from '../lib/portable.js'
import { loadState, resolveHomeDir, saveState, statePath } from '../lib/persist.js'
import { DEFAULT_CONFIG } from '../lib/config.js'

const port = Number(process.env.MEMSTACK_CONSOLE_PORT ?? 7788)
const homeDir = process.env.MEMSTACK_HOME?.trim() || resolveHomeDir()
const stateFile = statePath(homeDir)
const here = dirname(fileURLToPath(import.meta.url))
const MAX_BODY_BYTES = 32 * 1024 * 1024

const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/graph3d.js', ['graph3d.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/icon.svg', ['../icon.svg', 'image/svg+xml']],
])

function send(response, status, type, body, extraHeaders = {}) {
  response.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  })
  response.end(body)
}

function json(response, status, value) {
  send(response, status, 'application/json; charset=utf-8', JSON.stringify(value))
}

function fail(response, error) {
  const message = String(error?.message ?? error)
  const bad =
    /not-found|unknown-|empty-|self-|topic-taken|bank-archived|superseded-cannot|bad-bundle|invalid|required/i.test(message)
  json(response, bad ? 400 : 500, { error: message })
}

async function readStore() {
  const raw = await loadState(stateFile)
  return raw ? Store.fromJSON(raw) : new Store()
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request-too-large')
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('invalid-json')
  }
}

function decorate(store) {
  const now = new Date()
  const entries = Object.values(store.state.entries).map((entry) => {
    const decay = describeDecay(entry, now)
    return {
      ...entry,
      retention: decay.retention,
      stage: decay.stage,
      stageLabel: decay.stageLabel,
      stabilityDays: decay.stabilityDays,
      ageDays: decay.ageDays,
      nextReviewAt: decay.nextReviewAt,
    }
  })
  const banks = Object.values(store.state.banks)
  return {
    file: stateFile,
    generatedAt: now.toISOString(),
    banks,
    entries,
    links: Object.values(store.state.links),
    summary: summarize(entries, banks, [], [], now),
    config: publicConfig(),
  }
}

function publicConfig() {
  return {
    ...DEFAULT_CONFIG,
    homeDir,
    decay: {
      kindStability: KIND_STABILITY,
      firmRetention: 0.5,
      dormantRetention: 0.2,
      relationTypes: RELATION_TYPES,
    },
  }
}

function bankIdsFromQuery(store, query) {
  const ids = query.getAll('bank').filter(Boolean)
  if (!ids.length) return undefined
  return ids.filter((id) => store.state.banks[id] || Object.values(store.state.banks).some((bank) => bank.title === id))
}

/** Serializes state mutations: read-modify-write requests must not interleave. */
let chain = Promise.resolve()
function mutate(handler) {
  const run = chain.then(async () => {
    const store = await readStore()
    const result = await handler(store)
    await saveState(stateFile, store.toJSON())
    return { store, result }
  })
  chain = run.catch(() => {})
  return run
}

function fileStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
  try {
    if (request.method === 'GET' && STATIC.has(url.pathname)) {
      const [file, type] = STATIC.get(url.pathname)
      return send(response, 200, type, await readFile(join(here, file)))
    }

    if (request.method === 'GET' && url.pathname === '/api/state') {
      const store = await readStore()
      return json(response, 200, decorate(store))
    }

    if (request.method === 'GET' && url.pathname === '/api/graph') {
      const store = await readStore()
      const graph = buildGraph(store.toJSON(), {
        includeDerived: url.searchParams.get('derived') !== '0',
        includeInactive: url.searchParams.get('inactive') !== '0',
      })
      return json(response, 200, graph)
    }

    if (request.method === 'GET' && url.pathname === '/api/review-queue') {
      const store = await readStore()
      return json(response, 200, reviewQueue(store, { limit: Number(url.searchParams.get('limit')) || 20 }))
    }

    if (request.method === 'GET' && url.pathname === '/api/entry') {
      const store = await readStore()
      const view = store.state.entries[url.searchParams.get('id')]
        ? entryView(store, store.state.entries[url.searchParams.get('id')])
        : null
      return view ? json(response, 200, view) : json(response, 404, { error: 'entry-not-found' })
    }

    const bankAction = url.pathname.match(/^\/api\/bank\/([^/]+)\/(archive|restore|delete)$/)
    if (request.method === 'POST' && bankAction) {
      const [, id, operation] = bankAction
      const { store } = await mutate((state) => {
        if (!state.state.banks[id]) throw new Error('bank-not-found')
        if (operation === 'archive') state.archiveBank(id)
        if (operation === 'restore') state.restoreBank(id)
        if (operation === 'delete') state.deleteBank(id)
        return true
      })
      return json(response, 200, decorate(store))
    }

    const bankUpdate = url.pathname.match(/^\/api\/bank\/([^/]+)$/)
    if (request.method === 'POST' && bankUpdate) {
      const body = await readJson(request)
      const { store } = await mutate((state) => {
        if (!state.state.banks[bankUpdate[1]]) throw new Error('bank-not-found')
        state.updateBank(bankUpdate[1], body)
        return true
      })
      return json(response, 200, decorate(store))
    }

    if (request.method === 'POST' && url.pathname === '/api/bank') {
      const body = await readJson(request)
      if (!String(body.title ?? '').trim()) throw new Error('title-required')
      const { store } = await mutate((state) => {
        state.createBank({
          kind: body.kind === 'global' ? 'global' : 'topic',
          title: String(body.title).trim(),
          description: String(body.description ?? ''),
        })
      })
      return json(response, 200, decorate(store))
    }

    if (request.method === 'POST' && url.pathname === '/api/entry') {
      const body = await readJson(request)
      const { store } = await mutate((state) => {
        const bankId = body.bankId ?? visibleBanks(state)[0]?.id
        if (!bankId) throw new Error('bank-not-found')
        state.writeEntry({
          bankId,
          topic: body.topic,
          kind: body.kind ?? 'decision',
          claim: body.claim,
          detail: body.detail ?? '',
          rejected: body.rejected ?? [],
          confidence: body.confidence ?? 'verified',
          pin: Boolean(body.pinned ?? body.pin),
          tags: body.tags ?? [],
        })
      })
      return json(response, 200, decorate(store))
    }

    const entryAction = url.pathname.match(/^\/api\/entry\/([^/]+)\/(archive|restore|delete|pin|review|relate)$/)
    if (entryAction && ['POST', 'DELETE'].includes(request.method)) {
      const [, id, operation] = entryAction
      const body = request.method === 'POST' ? await readJson(request) : {}
      const { store, result } = await mutate((state) => {
        const entry = state.state.entries[id]
        if (!entry) throw new Error('entry-not-found')
        if (operation === 'archive') state.archiveEntry(id)
        if (operation === 'restore') state.restoreEntry(id)
        if (operation === 'delete') state.deleteEntry(id)
        if (operation === 'pin') state.updateEntry(id, { pinned: !entry.pinned })
        if (operation === 'review') state.reviewEntry(id)
        if (operation === 'relate') {
          if (request.method === 'DELETE') {
            state.unrelate(id, String(url.searchParams.get('target') ?? body.target ?? ''))
            return { removed: true }
          }
          state.relate(id, String(body.target ?? ''), body.type ?? 'related', body.note ?? '')
          return { related: true }
        }
        return null
      })
      return json(response, 200, { ...decorate(store), result })
    }

    const entryUpdate = url.pathname.match(/^\/api\/entry\/([^/]+)$/)
    if (request.method === 'POST' && entryUpdate) {
      const body = await readJson(request)
      const { store } = await mutate((state) => {
        if (!state.state.entries[entryUpdate[1]]) throw new Error('entry-not-found')
        state.updateEntry(entryUpdate[1], body)
      })
      return json(response, 200, decorate(store))
    }

    if (request.method === 'POST' && url.pathname === '/api/link') {
      const body = await readJson(request)
      const { store } = await mutate((state) => {
        state.link(body.fromBankId, body.toBankId, { recall: Boolean(body.recall), query: body.query !== false })
      })
      return json(response, 200, decorate(store))
    }

    if (request.method === 'DELETE' && url.pathname === '/api/link') {
      const { store } = await mutate((state) => {
        state.unlink(url.searchParams.get('from'), url.searchParams.get('to'))
      })
      return json(response, 200, decorate(store))
    }

    if (request.method === 'GET' && url.pathname === '/api/export') {
      const store = await readStore()
      const format = (url.searchParams.get('format') ?? 'json').toLowerCase()
      const bankIds = bankIdsFromQuery(store, url.searchParams)
      const stamp = fileStamp()
      if (format === 'markdown' || format === 'md') {
        const body = renderMarkdown(store.toJSON(), { bankIds })
        return send(response, 200, 'text/markdown; charset=utf-8', body, {
          'content-disposition': `attachment; filename="memstack-${stamp}.md"`,
        })
      }
      const bundle = buildBundle(store.toJSON(), {
        appVersion: '0.2.0',
        machine: hostname(),
        platform: process.platform,
        dshHome: homeDir,
      })
      return send(response, 200, 'application/json; charset=utf-8', serializeBundle(bundle), {
        'content-disposition': `attachment; filename="memstack-${stamp}.bundle.json"`,
      })
    }

    if (request.method === 'POST' && url.pathname === '/api/import') {
      const body = await readJson(request)
      const mode = body.mode === 'replace' ? 'replace' : 'merge'
      const bundle = parseBundle(body.bundle ?? body)
      let backup = null
      try {
        await stat(stateFile)
        backup = `${stateFile}.${fileStamp()}.bak`
        await copyFile(stateFile, backup)
      } catch {
        // First import on a fresh machine: nothing to back up.
      }
      const { store, result } = await mutate((state) => importState(state, bundle, { mode }))
      return json(response, 200, { ...decorate(store), report: result, backup })
    }

    if (request.method === 'GET' && url.pathname === '/api/health') {
      return json(response, 200, { ok: true, stateFile, homeDir, version: '0.2.0' })
    }

    return json(response, 404, { error: 'not-found' })
  } catch (error) {
    return fail(response, error)
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`MemStack console: http://127.0.0.1:${port}`)
  console.log(`state file: ${stateFile}`)
})
