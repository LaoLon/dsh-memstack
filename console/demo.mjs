/** Seeds a demo SQLite store and starts the console against it, without touching real memory. */

import { rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../lib/store.js'
import { commitStore, databasePath, openDatabase } from '../lib/database.js'
import { createDemoState } from './seed-demo.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const demoHome = join(here, '..', '.demo')
const dbFile = databasePath(demoHome)
const legacy = join(demoHome, 'memstack', 'state.json')
const port = process.env.MEMSTACK_CONSOLE_PORT ?? '7799'

for (const path of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`, legacy]) {
  rmSync(path, { force: true })
}

const db = openDatabase(dbFile)
try {
  const store = Store.fromJSON(createDemoState())
  store.markAllDirty()
  commitStore(db, store)
  console.log(`MemStack demo database: ${dbFile} (${Object.keys(store.state.entries).length} entries)`)
} finally {
  db.close()
}
console.log(`starting console on http://127.0.0.1:${port} (Ctrl+C to stop)`)

const child = spawn(process.execPath, [join(here, 'server.mjs')], {
  stdio: 'inherit',
  env: { ...process.env, MEMSTACK_HOME: demoHome, MEMSTACK_CONSOLE_PORT: port },
})
child.on('exit', (code) => process.exit(code ?? 0))
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill()
  })
}
