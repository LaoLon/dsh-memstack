/** MemStack console: a local, read/write view over $DSH_HOME/memstack/state.json. No DSH APIs. */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Store } from '../lib/store.js'
import { loadState, resolveHomeDir, saveState, statePath } from '../lib/persist.js'

const port = Number(process.env.MEMSTACK_CONSOLE_PORT ?? 7788)
const stateFile = statePath(resolveHomeDir())
const here = dirname(fileURLToPath(import.meta.url))

function send(response, status, type, body) {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  response.end(body)
}

function json(response, status, value) {
  send(response, status, 'application/json; charset=utf-8', JSON.stringify(value))
}

async function readStore() {
  const raw = await loadState(stateFile)
  return raw ? Store.fromJSON(raw) : new Store()
}

function describe(state) {
  return {
    file: stateFile,
    banks: Object.values(state.banks),
    entries: Object.values(state.entries),
    links: Object.values(state.links),
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
  try {
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(response, 200, 'text/html; charset=utf-8', await readFile(join(here, 'index.html'), 'utf8'))
    }

    if (request.method === 'GET' && url.pathname === '/api/state') {
      const store = await readStore()
      return json(response, 200, describe(store.toJSON()))
    }

    const action = url.pathname.match(/^\/api\/entry\/([^/]+)\/(archive|restore|delete|pin)$/)
    if (request.method === 'POST' && action) {
      const [, id, operation] = action
      const store = await readStore()
      const entry = store.getEntry(id)
      if (!entry) return json(response, 404, { error: 'entry-not-found' })
      if (operation === 'archive') store.archiveEntry(id)
      if (operation === 'restore') store.restoreEntry(id)
      if (operation === 'delete') store.deleteEntry(id)
      if (operation === 'pin') store.updateEntry(id, { pinned: !entry.pinned })
      await saveState(stateFile, store.toJSON())
      return json(response, 200, describe(store.toJSON()))
    }

    const bankAction = url.pathname.match(/^\/api\/bank\/([^/]+)\/(archive|restore|delete)$/)
    if (request.method === 'POST' && bankAction) {
      const [, id, operation] = bankAction
      const store = await readStore()
      if (!store.state.banks[id]) return json(response, 404, { error: 'bank-not-found' })
      if (operation === 'archive') store.archiveBank(id)
      if (operation === 'restore') store.restoreBank(id)
      if (operation === 'delete') store.deleteBank(id)
      await saveState(stateFile, store.toJSON())
      return json(response, 200, describe(store.toJSON()))
    }

    const bankUpdate = url.pathname.match(/^\/api\/bank\/([^/]+)$/)
    if (request.method === 'POST' && bankUpdate) {
      const [, id] = bankUpdate
      const body = await readJson(request)
      const store = await readStore()
      if (!store.state.banks[id]) return json(response, 404, { error: 'bank-not-found' })
      store.updateBank(id, body)
      await saveState(stateFile, store.toJSON())
      return json(response, 200, describe(store.toJSON()))
    }

    if (request.method === 'POST' && url.pathname === '/api/bank') {
      const body = await readJson(request)
      if (!String(body.title ?? '').trim()) return json(response, 400, { error: 'title-required' })
      const store = await readStore()
      store.createBank({
        kind: body.kind === 'global' ? 'global' : 'topic',
        title: String(body.title).trim(),
        description: String(body.description ?? ''),
      })
      await saveState(stateFile, store.toJSON())
      return json(response, 200, describe(store.toJSON()))
    }

    if (request.method === 'POST' && url.pathname === '/api/link') {
      const body = await readJson(request)
      const store = await readStore()
      store.link(body.fromBankId, body.toBankId, {
        recall: Boolean(body.recall),
        query: body.query !== false,
      })
      await saveState(stateFile, store.toJSON())
      return json(response, 200, describe(store.toJSON()))
    }

    if (request.method === 'DELETE' && url.pathname === '/api/link') {
      const store = await readStore()
      store.unlink(url.searchParams.get('from'), url.searchParams.get('to'))
      await saveState(stateFile, store.toJSON())
      return json(response, 200, describe(store.toJSON()))
    }

    return json(response, 404, { error: 'not-found' })
  } catch (error) {
    return json(response, 500, { error: String(error?.message ?? error) })
  }
})

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  return raw ? JSON.parse(raw) : {}
}

server.listen(port, '127.0.0.1', () => {
  console.log(`MemStack console: http://127.0.0.1:${port}`)
  console.log(`state file: ${stateFile}`)
})
