/**
 * SQLite persistence for MemStack. Zero npm dependencies: `node:sqlite` ships
 * with the Node runtime bundled by DSH.
 *
 * The relational tables are an index over the domain objects plus a compact
 * JSON payload per object. Writes are incremental (only dirty rows change), and
 * `revision` lets the Host and console detect each other's commits. The JSON
 * bundle remains the portable interchange format; this database is local state.
 */

import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { Store, SCHEMA_VERSION } from './store.js'

export const DATABASE_FILENAME = 'memstack.db'
export const DATABASE_SCHEMA_VERSION = 1

export function resolveHomeDir(env = process.env) {
  return env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

export function databasePath(homeDir) {
  return join(homeDir, 'memstack', DATABASE_FILENAME)
}

/** The v1/v2 JSON state, read once during migration. Not used afterwards. */
export function legacyStatePath(homeDir) {
  return join(homeDir, 'memstack', 'state.json')
}

function databaseSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS banks (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      archived_at TEXT,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      bank_id TEXT NOT NULL,
      topic TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      confidence TEXT NOT NULL,
      pinned INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS links (
      key TEXT PRIMARY KEY,
      from_bank_id TEXT NOT NULL,
      to_bank_id TEXT NOT NULL,
      payload TEXT NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS entries_bank_status ON entries(bank_id, status);
    CREATE INDEX IF NOT EXISTS entries_topic ON entries(topic);
    CREATE INDEX IF NOT EXISTS entries_status ON entries(status);
    CREATE INDEX IF NOT EXISTS entries_updated ON entries(updated_at);
    CREATE INDEX IF NOT EXISTS banks_kind ON banks(kind);
    CREATE INDEX IF NOT EXISTS links_from ON links(from_bank_id);
    CREATE INDEX IF NOT EXISTS links_to ON links(to_bank_id);
  `)
  const insertMeta = db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)')
  for (const [key, value] of [
    ['db_schema', String(DATABASE_SCHEMA_VERSION)],
    ['store_schema', String(SCHEMA_VERSION)],
    ['revision', '0'],
    ['store_meta', JSON.stringify({ defaultBankByWorkspace: {}, inboxOrder: [] })],
  ]) {
    insertMeta.run(key, value)
  }
  const version = Number(db.prepare("SELECT value FROM meta WHERE key = 'db_schema'").get()?.value ?? 0)
  if (version > DATABASE_SCHEMA_VERSION) {
    throw new Error(`database-schema-too-new:${version}>${DATABASE_SCHEMA_VERSION}`)
  }
}

export function openDatabase(file, { timeout = 5000 } = {}) {
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file, { timeout })
  try {
    databaseSchema(db)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

export function getRevision(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'revision'").get()
  return Number(row?.value ?? 0)
}

function bumpRevision(db) {
  db.prepare("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision'").run()
  return getRevision(db)
}

function writeMeta(db, meta) {
  db.prepare("INSERT INTO meta (key, value) VALUES ('store_meta', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    JSON.stringify(meta ?? { defaultBankByWorkspace: {}, inboxOrder: [] }),
  )
}

export function loadRawState(db) {
  const banks = {}
  for (const row of db.prepare('SELECT id, payload FROM banks').all()) {
    banks[row.id] = JSON.parse(row.payload)
  }
  const entries = {}
  for (const row of db.prepare('SELECT id, payload FROM entries').all()) {
    entries[row.id] = JSON.parse(row.payload)
  }
  const links = {}
  for (const row of db.prepare('SELECT key, payload FROM links').all()) {
    links[row.key] = JSON.parse(row.payload)
  }
  let meta = { defaultBankByWorkspace: {}, inboxOrder: [] }
  const metaRow = db.prepare("SELECT value FROM meta WHERE key = 'store_meta'").get()
  if (metaRow?.value) {
    try {
      meta = JSON.parse(metaRow.value)
    } catch {
      // Keep the safe default; Store.fromJSON will normalize what it can.
    }
  }
  return { schemaVersion: SCHEMA_VERSION, banks, entries, links, meta }
}

export function loadStore(db, options = {}) {
  return Store.fromJSON(loadRawState(db), options)
}

function preparedStatements(db) {
  return {
    bank: db.prepare(`
      INSERT INTO banks (id, kind, title, archived_at, updated_at, payload)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind, title = excluded.title, archived_at = excluded.archived_at,
        updated_at = excluded.updated_at, payload = excluded.payload
    `),
    entry: db.prepare(`
      INSERT INTO entries (id, bank_id, topic, kind, status, confidence, pinned, created_at, updated_at, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        bank_id = excluded.bank_id, topic = excluded.topic, kind = excluded.kind,
        status = excluded.status, confidence = excluded.confidence, pinned = excluded.pinned,
        created_at = excluded.created_at, updated_at = excluded.updated_at, payload = excluded.payload
    `),
    link: db.prepare(`
      INSERT INTO links (key, from_bank_id, to_bank_id, payload)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        from_bank_id = excluded.from_bank_id, to_bank_id = excluded.to_bank_id,
        payload = excluded.payload
    `),
    deleteBank: db.prepare('DELETE FROM banks WHERE id = ?'),
    deleteEntry: db.prepare('DELETE FROM entries WHERE id = ?'),
    deleteLink: db.prepare('DELETE FROM links WHERE key = ?'),
  }
}

function putBank(stmt, bank) {
  stmt.run(
    bank.id,
    String(bank.kind ?? 'topic'),
    String(bank.title ?? 'Untitled'),
    bank.archivedAt ?? null,
    String(bank.updatedAt ?? bank.createdAt ?? ''),
    JSON.stringify(bank),
  )
}

function putEntry(stmt, entry) {
  stmt.run(
    entry.id,
    String(entry.bankId ?? ''),
    String(entry.topic ?? ''),
    String(entry.kind ?? 'decision'),
    String(entry.status ?? 'active'),
    String(entry.confidence ?? 'verified'),
    entry.pinned ? 1 : 0,
    String(entry.createdAt ?? ''),
    String(entry.updatedAt ?? entry.createdAt ?? ''),
    JSON.stringify(entry),
  )
}

function putLink(stmt, key, link) {
  stmt.run(key, String(link.fromBankId ?? ''), String(link.toBankId ?? ''), JSON.stringify(link))
}

function replaceAll(db, state) {
  const stmts = preparedStatements(db)
  db.exec('DELETE FROM entries; DELETE FROM banks; DELETE FROM links;')
  for (const bank of Object.values(state.banks ?? {})) putBank(stmts.bank, bank)
  for (const entry of Object.values(state.entries ?? {})) putEntry(stmts.entry, entry)
  for (const [key, link] of Object.entries(state.links ?? {})) putLink(stmts.link, key, link)
  writeMeta(db, state.meta)
}

/** Rewrites one dirty entity or removes it when it no longer exists. */
function applyDirty(db, store) {
  const state = store.state
  const dirty = store.dirty
  if (dirty.all) {
    replaceAll(db, state)
    return
  }

  const stmts = preparedStatements(db)
  for (const id of dirty.banks) {
    if (state.banks[id]) putBank(stmts.bank, state.banks[id])
    else stmts.deleteBank.run(id)
  }
  for (const id of dirty.entries) {
    if (state.entries[id]) putEntry(stmts.entry, state.entries[id])
    else stmts.deleteEntry.run(id)
  }
  for (const key of dirty.links) {
    if (state.links[key]) putLink(stmts.link, key, state.links[key])
    else stmts.deleteLink.run(key)
  }

  // Reconciliation is cheap (index-only) and protects against a missed dirty
  // mark after a bulk mutation. It also removes rows for deleted entities.
  const bankIds = new Set(db.prepare('SELECT id FROM banks').all().map((row) => row.id))
  for (const id of bankIds) if (!state.banks[id]) stmts.deleteBank.run(id)
  const entryIds = new Set(db.prepare('SELECT id FROM entries').all().map((row) => row.id))
  for (const id of entryIds) if (!state.entries[id]) stmts.deleteEntry.run(id)
  const linkKeys = new Set(db.prepare('SELECT key FROM links').all().map((row) => row.key))
  for (const key of linkKeys) if (!state.links[key]) stmts.deleteLink.run(key)

  if (dirty.meta) writeMeta(db, state.meta)
}

export function hasDirty(store) {
  const dirty = store.dirty
  return Boolean(dirty?.all || dirty?.meta || dirty?.banks?.size || dirty?.entries?.size || dirty?.links?.size)
}

function commitDirty(db, store) {
  applyDirty(db, store)
  const revision = bumpRevision(db)
  store.clearDirty()
  return revision
}

/**
 * Commits a Store snapshot. Pass the revision the caller loaded to detect a
 * concurrent console/Host write instead of silently overwriting it.
 */
export function commitStore(db, store, { expectedRevision } = {}) {
  if (!hasDirty(store)) return getRevision(db)
  db.exec('BEGIN IMMEDIATE')
  try {
    const current = getRevision(db)
    if (expectedRevision !== undefined && Number(expectedRevision) !== current) {
      throw new Error(`state-conflict:${expectedRevision}->${current}`)
    }
    const revision = commitDirty(db, store)
    db.exec('COMMIT')
    return revision
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export async function backupDatabase(db, file) {
  mkdirSync(dirname(file), { recursive: true })
  await sqliteBackup(db, file)
  return file
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
}

function removeDatabaseFiles(file) {
  for (const path of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      rmSync(path, { force: true })
    } catch {
      // Best effort: leave a file we cannot remove for the operator to inspect.
    }
  }
}

function isEmptyDatabase(db) {
  return (
    getRevision(db) === 0 &&
    db.prepare('SELECT COUNT(*) AS n FROM banks').get().n === 0 &&
    db.prepare('SELECT COUNT(*) AS n FROM entries').get().n === 0 &&
    db.prepare('SELECT COUNT(*) AS n FROM links').get().n === 0
  )
}

/**
 * Opens (and if necessary creates) the SQLite database. When this is the first
 * run and a legacy `state.json` exists, its contents are imported and the JSON
 * file is renamed to `state.json.migrated-<stamp>.bak` so it is never read twice.
 */
export function openHomeDatabase(homeDir = resolveHomeDir(), { logger } = {}) {
  const file = databasePath(homeDir)
  const legacy = legacyStatePath(homeDir)
  const existed = existsSync(file)

  let legacyStore = null
  if (!existed && existsSync(legacy)) {
    try {
      legacyStore = Store.fromJSON(JSON.parse(readFileSync(legacy, 'utf8')))
      legacyStore.markAllDirty()
    } catch (error) {
      throw new Error(`legacy-migration-failed:${error.message}`)
    }
  }

  const db = openDatabase(file)
  if (!legacyStore) return db

  const backup = `${legacy}.migrated-${stamp()}.bak`
  db.exec('BEGIN IMMEDIATE')
  try {
    // Another process may have created and populated the DB between the
    // existsSync check and openDatabase(); never overwrite committed data.
    if (!isEmptyDatabase(db)) {
      db.exec('ROLLBACK')
      logger?.warn?.('memstack: database already has data, ignoring legacy state.json at %s', legacy)
      return db
    }
    commitDirty(db, legacyStore)
    db.exec('COMMIT')
    renameSync(legacy, backup)
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // Already committed (e.g. the rename failed); closing is enough.
    }
    db.close()
    if (!existed) removeDatabaseFiles(file)
    throw new Error(`legacy-migration-failed:${error.message}`)
  }
  logger?.info?.('memstack: migrated state.json to %s (backup: %s)', file, backup)
  return db
}

/** Long-lived connection with a cached Store; the console uses this. */
export class StoreDatabase {
  constructor(homeDir = resolveHomeDir(), options = {}) {
    this.file = databasePath(homeDir)
    this.db = openHomeDatabase(homeDir, options)
    this.revision = getRevision(this.db)
    this.store = loadStore(this.db)
  }

  /** Reloads when another process committed; otherwise returns the cached Store. */
  readStore() {
    const revision = getRevision(this.db)
    if (revision !== this.revision) {
      this.store = loadStore(this.db)
      this.revision = revision
    }
    return this.store
  }

  /** One read-modify-write transaction. The handler must be synchronous. */
  async mutate(handler) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const revision = getRevision(this.db)
      if (revision !== this.revision) {
        this.store = loadStore(this.db)
        this.revision = revision
      }
      const result = handler(this.store)
      if (hasDirty(this.store)) this.revision = commitDirty(this.db, this.store)
      else this.revision = getRevision(this.db)
      this.db.exec('COMMIT')
      return { store: this.store, result }
    } catch (error) {
      this.db.exec('ROLLBACK')
      this.revision = getRevision(this.db)
      this.store = loadStore(this.db)
      throw error
    }
  }

  commit() {
    this.revision = commitStore(this.db, this.store, { expectedRevision: this.revision })
    return this.revision
  }

  close() {
    try {
      this.db.close()
    } catch {
      // Already closed.
    }
  }
}
