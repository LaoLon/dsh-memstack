/**
 * Safety rails for destructive development scripts.
 *
 * The 2026-11-03 incident: a one-liner ended with
 * `Remove-Item -LiteralPath $home -Recurse -Force`, where `$home` is
 * PowerShell's read-only automatic variable (always the user profile). The
 * intended temp directory was never used and the whole profile was deleted.
 *
 * Rules encoded here:
 *   - deletion targets must resolve inside the temp root (after realpath),
 *   - the temp root itself must not sit at/above a protected directory,
 *     otherwise a poisoned TMP/TEMP would re-open the same hole,
 *   - a target may never be an ancestor of a protected directory or of this
 *     repository,
 *   - nothing is ever built by string concatenation: real paths only.
 *
 * Zero dependencies, plain ESM, so `node --test` covers it on bare Node.
 */

import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export class GuardError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'GuardError'
    this.code = code
  }
}

const IS_WINDOWS = process.platform === 'win32'

function norm(path) {
  return IS_WINDOWS ? path.toLowerCase() : path
}

/** Absolute real path when the entry exists; best-effort absolute path otherwise. */
export function canonical(path) {
  const absolute = resolve(path)
  try {
    return realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

export function samePath(a, b) {
  return norm(canonical(a)) === norm(canonical(b))
}

/** True when `child` is strictly inside `parent` (equal paths are not "inside"). */
export function isInside(child, parent) {
  const rel = relative(norm(canonical(parent)), norm(canonical(child)))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export function isAncestorOrSelf(candidate, path) {
  return samePath(candidate, path) || isInside(path, candidate)
}

/**
 * Directories whose loss breaks the machine, the harness, or this repo.
 * Only "target is at/above one of these" is dangerous; temp lives *inside*
 * the profile by design, so containment alone must not refuse it.
 */
export function protectedPaths(env = process.env) {
  const candidates = [
    env.USERPROFILE,
    env.HOME,
    homedir(),
    env.DSH_HOME,
    join(homedir(), '.dsh'),
    join(homedir(), '.config'),
    join(homedir(), '.local'),
    env.APPDATA,
    env.LOCALAPPDATA,
  ].filter((value) => typeof value === 'string' && value.trim() !== '')
  return [...new Set(candidates.map((value) => canonical(value)))]
}

/** TMP/TEMP/TMPDIR are attacker-controlled in a session: validate before trusting. */
export function defaultTempRoot(env = process.env) {
  const raw = env.TMPDIR || env.TEMP || env.TMP || tmpdir()
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new GuardError('temp-root-missing', 'refusing to delete: no usable temp directory')
  }
  return canonical(raw)
}

function assertSafeTempRoot(root, protectedList) {
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new GuardError('temp-root-missing', `refusing to delete: temp root is not a directory: ${root}`)
  }
  for (const path of protectedList) {
    if (isAncestorOrSelf(root, path)) {
      throw new GuardError(
        'temp-root-unsafe',
        `refusing to delete: temp root ${root} contains protected path ${path}; fix TMP/TEMP or pass a dedicated temp root`,
      )
    }
  }
}

/**
 * Throws unless `target` is provably safe to remove recursively.
 * Returns the resolved real path so callers never delete the unresolved string.
 */
export function assertSafeToDelete(
  target,
  { tempRoot = defaultTempRoot(), protected: extra = [], repoRoot } = {},
) {
  if (typeof target !== 'string' || target.trim() === '') {
    throw new GuardError('missing-target', 'refusing to delete: no target path given')
  }
  if (!existsSync(target)) {
    throw new GuardError('not-found', `refusing to delete: path does not exist: ${target}`)
  }

  const real = canonical(target)
  const root = canonical(tempRoot)
  const guarded = [...protectedPaths(), ...extra.filter(Boolean).map((value) => canonical(value))]
  assertSafeTempRoot(root, guarded)

  if (samePath(real, root)) {
    throw new GuardError('temp-root', `refusing to delete the temp root itself: ${real}`)
  }
  for (const path of guarded) {
    if (isAncestorOrSelf(real, path)) {
      throw new GuardError('protected', `refusing to delete ${real}: it contains protected path ${path}`)
    }
  }
  if (repoRoot && isAncestorOrSelf(real, repoRoot)) {
    throw new GuardError('repo', `refusing to delete ${real}: it contains this repository (${canonical(repoRoot)})`)
  }
  if (!isInside(real, root)) {
    throw new GuardError(
      'outside-temp',
      `refusing to delete ${real}: only paths strictly inside ${root} may be deleted`,
    )
  }
  return real
}

/** Creates a throwaway home under the temp root. Never derives it from the profile. */
export function createTempHome({ prefix = 'memstack-home-', tempRoot = defaultTempRoot() } = {}) {
  if (prefix.includes('/') || prefix.includes('\\') || prefix.includes('..')) {
    throw new GuardError('bad-prefix', `invalid temp home prefix: ${prefix}`)
  }
  const root = canonical(tempRoot)
  assertSafeTempRoot(root, protectedPaths())
  return mkdtempSync(join(root, prefix))
}

/** Deletes a temp home after checking it. Returns the real path that was removed. */
export function deleteTempHome(target, options = {}) {
  const real = assertSafeToDelete(target, options)
  rmSync(real, { recursive: true, force: false, maxRetries: 3, retryDelay: 50 })
  return real
}

/** Human-readable one-liner for logs and approvals. */
export function describeTarget(target) {
  return existsSync(target) ? canonical(target) : `${resolve(target)} (missing)`
}

export { sep }
