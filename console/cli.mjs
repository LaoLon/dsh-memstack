#!/usr/bin/env node
/** MemStack CLI: machine-to-machine export/import that shares lib/portable.js with the console. */

import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, resolve } from 'node:path'
import { Store } from '../lib/store.js'
import { loadState, resolveHomeDir, saveState, statePath } from '../lib/persist.js'
import {
  buildBundle,
  importState,
  parseBundle,
  renderMarkdown,
  serializeBundle,
} from '../lib/portable.js'

function parseArgs(argv) {
  const flags = { banks: [] }
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--help' || token === '-h') flags.help = true
    else if (token === '--out' || token === '-o') flags.out = argv[++index]
    else if (token === '--mode') flags.mode = argv[++index]
    else if (token === '--bank') flags.banks.push(argv[++index])
    else if (token === '--format') flags.format = argv[++index]
    else if (token === '--home') flags.home = argv[++index]
    else if (token === '--dry-run') flags.dryRun = true
    else if (token === '--help') flags.help = true
    else if (!token.startsWith('-')) positional.push(token)
  }
  return { flags, positional }
}

function usage() {
  return [
    'MemStack 数据迁移',
    '',
    '导出（JSON bundle，含历史）：',
    '  npm run export -- -o memstack.bundle.json [--bank <id|title>]...',
    '导出（Markdown 投影）：',
    '  npm run export -- --format markdown -o memory.md',
    '导入：',
    '  npm run import -- memstack.bundle.json [--mode merge|replace] [--dry-run]',
    '',
    '选项：--home <DSH_HOME> 覆盖数据目录（默认 $DSH_HOME 或 ~/.dsh）',
  ].join('\n')
}

async function readStore(homeDir) {
  const raw = await loadState(statePath(homeDir))
  return raw ? Store.fromJSON(raw) : new Store()
}

async function exportCommand(flags) {
  const homeDir = flags.home ? resolve(flags.home) : resolveHomeDir()
  const store = await readStore(homeDir)
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  if ((flags.format ?? 'json').toLowerCase() === 'markdown') {
    const out = resolve(flags.out ?? `memstack-${stamp}.md`)
    const bankIds = flags.banks.length
      ? Object.values(store.state.banks)
          .filter((bank) => flags.banks.includes(bank.id) || flags.banks.includes(bank.title))
          .map((bank) => bank.id)
      : undefined
    const body = renderMarkdown(store.toJSON(), { bankIds: bankIds ?? Object.keys(store.state.banks) })
    await mkdir(dirname(out), { recursive: true })
    await writeFile(out, body, 'utf8')
    console.log(`已导出 Markdown：${out}`)
    return
  }
  const bankIds = flags.banks.length
    ? Object.values(store.state.banks)
        .filter((bank) => flags.banks.includes(bank.id) || flags.banks.includes(bank.title))
        .map((bank) => bank.id)
    : undefined
  const state = store.toJSON()
  if (bankIds) {
    const allowed = new Set(bankIds)
    state.banks = Object.fromEntries(Object.entries(state.banks).filter(([id]) => allowed.has(id)))
    state.entries = Object.fromEntries(Object.entries(state.entries).filter(([, entry]) => allowed.has(entry.bankId)))
    state.links = Object.fromEntries(
      Object.entries(state.links).filter(([, link]) => allowed.has(link.fromBankId) && allowed.has(link.toBankId)),
    )
    for (const entry of Object.values(state.entries)) {
      entry.relations = (entry.relations ?? []).filter((relation) => state.entries[relation.target])
    }
  }
  const bundle = buildBundle(state, {
    appVersion: '0.2.0',
    machine: hostname(),
    platform: process.platform,
    dshHome: homeDir,
  })
  const out = resolve(flags.out ?? `memstack-${stamp}.bundle.json`)
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, serializeBundle(bundle), 'utf8')
  console.log(`已导出 ${bundle.stats.banks} 个库 / ${bundle.stats.entries} 条记忆：${out}`)
}

async function importCommand(flags, positional) {
  const file = positional[0]
  if (!file) throw new Error('缺少要导入的 bundle 文件')
  const mode = flags.mode === 'replace' ? 'replace' : 'merge'
  const homeDir = flags.home ? resolve(flags.home) : resolveHomeDir()
  const path = statePath(homeDir)
  const bundle = parseBundle(await readFile(resolve(file), 'utf8'))
  const raw = await loadState(path)
  const store = raw ? Store.fromJSON(raw) : new Store()
  const report = importState(store, bundle, { mode })

  if (flags.dryRun) {
    console.log(JSON.stringify(report, null, 2))
    console.log('dry-run：未写入任何数据')
    return
  }

  try {
    await stat(path)
    const backup = `${path}.${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')}.bak`
    await copyFile(path, backup)
    console.log(`已备份原数据：${backup}`)
  } catch {
    // No existing state: nothing to back up.
  }

  await saveState(path, store.toJSON())
  console.log(`已导入（${mode}）：+${report.entriesAdded} 条，跳过 ${report.entriesSkipped} 条，冲突 ${report.conflicts.length} 个`)
  console.log(JSON.stringify(report, null, 2))
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2))
  const command = positional.shift()
  if (!command || flags.help) {
    console.log(usage())
    return
  }
  if (command === 'export') return exportCommand(flags)
  if (command === 'import') return importCommand(flags, positional)
  throw new Error(`未知命令：${command}`)
}

main().catch((error) => {
  console.error(String(error?.message ?? error))
  process.exitCode = 1
})
