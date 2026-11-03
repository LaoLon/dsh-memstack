import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  GuardError,
  assertSafeToDelete,
  createTempHome,
  defaultTempRoot,
  deleteTempHome,
  isInside,
} from '../scripts/guard.mjs'

const cleanups = []

function tempHome(prefix = 'memstack-guard-') {
  const dir = createTempHome({ prefix })
  cleanups.push(dir)
  return dir
}

function keep(dir) {
  cleanups.push(dir)
  return dir
}

test.after(() => {
  for (const dir of cleanups.reverse()) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    } catch {
      // A leftover temp dir is preferable to a failing test run.
    }
  }
})

function codeOf(fn) {
  try {
    fn()
  } catch (error) {
    assert.ok(error instanceof GuardError, `expected GuardError, got ${error?.name}: ${error?.message}`)
    return error.code
  }
  assert.fail('expected the guard to refuse, but it allowed the operation')
}

test('新建的临时 home 落在临时根内，且能被安全删除', () => {
  const home = tempHome()
  assert.ok(isInside(home, defaultTempRoot()))
  writeFileSync(join(home, 'state.json'), '{}', 'utf8')
  const removed = deleteTempHome(home, { repoRoot: join(home, '..', 'not-the-repo') })
  assert.equal(existsSync(removed), false)
})

test('空路径直接拒绝，绝不使用默认值', () => {
  assert.equal(codeOf(() => assertSafeToDelete('')), 'missing-target')
  assert.equal(codeOf(() => assertSafeToDelete('   ')), 'missing-target')
  assert.equal(codeOf(() => assertSafeToDelete(undefined)), 'missing-target')
})

test('不存在的路径拒绝删除', () => {
  assert.equal(codeOf(() => assertSafeToDelete(join(tempHome(), 'nope'))), 'not-found')
})

test('拒绝删除临时根本身', () => {
  assert.equal(codeOf(() => assertSafeToDelete(defaultTempRoot())), 'temp-root')
})

test('拒绝删除用户目录：这正是 2026-11-03 事故的形态', () => {
  assert.equal(codeOf(() => assertSafeToDelete(homedir())), 'protected')
})

test('拒绝删除 DSH 家目录及其内容', () => {
  const dshHome = join(homedir(), '.dsh')
  if (!existsSync(dshHome)) return
  assert.equal(codeOf(() => assertSafeToDelete(dshHome)), 'protected')
  const inside = join(dshHome, 'profiles')
  if (existsSync(inside)) assert.equal(codeOf(() => assertSafeToDelete(inside)), 'outside-temp')
})

test('拒绝删除仓库根目录', () => {
  const home = tempHome()
  const repo = join(home, 'repo')
  mkdirSync(repo)
  assert.equal(codeOf(() => assertSafeToDelete(home, { repoRoot: repo })), 'repo')
  // 同一个目录，换一个不相干的 repoRoot 就可以删：判定依据是真实位置，不是名字。
  assert.equal(deleteTempHome(home, { repoRoot: join(home, '..', 'elsewhere') }), home)
})

test('临时根被污染时（TMP 指向用户目录）整体拒绝', () => {
  const dshHome = join(homedir(), '.dsh')
  if (!existsSync(dshHome)) return
  assert.equal(codeOf(() => assertSafeToDelete(dshHome, { tempRoot: homedir() })), 'temp-root-unsafe')
})

test('目标不在给定临时根内则拒绝', () => {
  const outer = tempHome()
  const root = join(outer, 'root')
  mkdirSync(root)
  keep(root)
  assert.equal(codeOf(() => assertSafeToDelete(outer, { tempRoot: root })), 'outside-temp')
})

test('junction 指向受保护目录时按真实路径拒绝', (t) => {
  const home = tempHome()
  const link = join(home, 'escape')
  const dshHome = join(homedir(), '.dsh')
  if (!existsSync(dshHome)) return
  try {
    symlinkSync(dshHome, link, 'junction')
  } catch {
    t.skip('无法创建 junction（需要相应权限）')
    return
  }
  const code = codeOf(() => assertSafeToDelete(link))
  assert.ok(['protected', 'outside-temp'].includes(code), `unexpected code: ${code}`)
  assert.ok(existsSync(dshHome), 'DSH 家目录必须完好无损')
})

test('大小写不敏感：同一路径的不同写法仍被识别为临时根内', () => {
  const home = tempHome()
  if (process.platform !== 'win32') return
  assert.ok(isInside(home.toUpperCase(), defaultTempRoot().toUpperCase()))
  assert.equal(deleteTempHome(home.toUpperCase()), home)
})
