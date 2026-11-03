#!/usr/bin/env node
/**
 * The only sanctioned way to create or remove a throwaway home in this repo.
 *
 *   node scripts/home.mjs new                 # print a fresh temp home path
 *   node scripts/home.mjs check <path>        # resolve + verdict, deletes nothing
 *   node scripts/home.mjs reset <path>        # check, then delete recursively
 *   node scripts/home.mjs backup [--to DIR]   # copy ~/.dsh (+ opencode config)
 *
 * `reset` requires an explicit path: there is no default, no glob, no `$home`.
 * `backup` only ever copies, and defaults to a directory on another volume so
 * a profile-wide wipe cannot take the backup with it.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  GuardError,
  canonical,
  createTempHome,
  defaultTempRoot,
  deleteTempHome,
  describeTarget,
  isInside,
  assertSafeToDelete,
} from './guard.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function usage() {
  console.error(
    [
      'usage:',
      '  node scripts/home.mjs new [--prefix NAME]',
      '  node scripts/home.mjs check <path>',
      '  node scripts/home.mjs reset <path>',
      '  node scripts/home.mjs backup [--to DIR] [--skip-opencode]',
      '',
      'reset only accepts paths inside the temp root; see scripts/guard.mjs.',
    ].join('\n'),
  )
  process.exit(2)
}

function flag(args, name) {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--')) usage()
  return value
}

function walk(dir) {
  let files = 0
  let bytes = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = walk(path)
      files += nested.files
      bytes += nested.bytes
    } else if (entry.isFile()) {
      files += 1
      bytes += statSync(path).size
    }
  }
  return { files, bytes }
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
}

function expand(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return resolve(path)
}

function dshHome() {
  const explicit = process.env.DSH_HOME?.trim()
  return explicit ? resolve(expand(explicit)) : join(homedir(), '.dsh')
}

function defaultBackupRoot() {
  const explicit = process.env.MEMSTACK_BACKUP_DIR?.trim()
  if (explicit) return resolve(expand(explicit))
  // Another volume on purpose: deleting the profile must not delete the backup.
  return process.platform === 'win32' ? 'D:\\dsh-backups' : join(homedir(), 'dsh-backups')
}

function backup(args) {
  const target = resolve(expand(flag(args, '--to') ?? defaultBackupRoot()))
  const skipOpencode = args.includes('--skip-opencode')
  const withOpencodeData = args.includes('--with-opencode-data')

  const sources = [{ name: 'dsh', path: dshHome() }]
  if (!skipOpencode) {
    const config = join(homedir(), '.config', 'opencode')
    if (existsSync(config)) sources.push({ name: 'opencode-config', path: config })
    // Opt-in: opencode.db is live (WAL), so copying it while the app runs can
    // yield an inconsistent snapshot. Config is the part worth saving blindly.
    const data = join(homedir(), '.local', 'share', 'opencode')
    if (withOpencodeData && existsSync(join(data, 'opencode.db'))) {
      sources.push({ name: 'opencode-data', path: data, only: ['opencode.db', 'opencode.db-wal', 'opencode.db-shm'] })
    }
  }

  for (const source of sources) {
    if (!existsSync(source.path)) throw new GuardError('backup-source-missing', `backup source not found: ${source.path}`)
    if (isInside(target, source.path) || canonical(target) === canonical(source.path)) {
      throw new GuardError('backup-recursion', `backup destination ${target} is inside source ${source.path}`)
    }
  }

  const destination = join(target, `dsh-backup-${stamp()}`)
  mkdirSync(destination, { recursive: true })

  const manifest = { createdAt: new Date().toISOString(), repoRoot: REPO_ROOT, sources: [] }
  for (const source of sources) {
    const into = join(destination, source.name)
    if (source.only) {
      mkdirSync(into, { recursive: true })
      for (const name of source.only) {
        const from = join(source.path, name)
        if (existsSync(from)) cpSync(from, join(into, name))
      }
    } else {
      // The bundled node runtime is re-downloadable; excluding it keeps daily
      // backups to a few hundred KB instead of ~90 MB.
      const skipRuntimes = (from) => !/[\\/]dsh-runtimes([\\/]|$)/.test(from)
      cpSync(source.path, into, { recursive: true, dereference: false, errorOnExist: false, filter: skipRuntimes })
    }
    const { files, bytes } = walk(into)
    manifest.sources.push({ name: source.name, from: source.path, files, bytes })
    console.log(`copied ${source.name}: ${files} files, ${bytes} bytes -> ${into}`)
  }
  writeFileSync(join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`backup complete: ${destination}`)
  return destination
}

function main() {
  const [command, ...args] = process.argv.slice(2)
  if (!command) usage()

  if (command === 'new') {
    const prefix = flag(args, '--prefix') ?? 'memstack-home-'
    console.log(createTempHome({ prefix }))
    return
  }

  if (command === 'check') {
    const target = args[0]
    if (!target) usage()
    try {
      const real = assertSafeToDelete(target, { repoRoot: REPO_ROOT })
      console.log(`ok       ${real}`)
      console.log(`         (inside ${defaultTempRoot()})`)
    } catch (error) {
      if (!(error instanceof GuardError)) throw error
      console.error(`refused  [${error.code}] ${error.message}`)
      process.exit(1)
    }
    return
  }

  if (command === 'reset') {
    const target = args[0]
    if (!target) usage()
    console.log(`about to delete: ${describeTarget(target)}`)
    try {
      const real = deleteTempHome(target, { repoRoot: REPO_ROOT })
      console.log(`removed  ${real}`)
    } catch (error) {
      if (!(error instanceof GuardError)) throw error
      console.error(`refused  [${error.code}] ${error.message}`)
      process.exit(1)
    }
    return
  }

  if (command === 'backup') {
    backup(args)
    return
  }

  usage()
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()

export { backup, dshHome, defaultBackupRoot }
