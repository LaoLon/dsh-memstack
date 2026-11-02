/** Snapshot + diff used to inject only what changed. Pure: no DSH imports. */

import { escapeMemoryText } from './render.js'

/**
 * Snapshot of the active entries visible to one session's bank set, keyed by
 * `bankId::topic` so a superseding write counts as an update of the same claim,
 * not as an unrelated add plus delete.
 */
export function snapshotOf(store, bankIds) {
  const snapshot = {}
  for (const bankId of bankIds) {
    const bank = store.state.banks[bankId]
    if (!bank || bank.archivedAt) continue
    for (const entry of store.listEntries(bankId, { status: 'active' })) {
      snapshot[`${bankId}::${entry.topic}`] = {
        id: entry.id,
        bankId,
        topic: entry.topic,
        claim: entry.claim,
        updatedAt: entry.updatedAt,
        reasons: (entry.rejected ?? []).map((item) => item.reason).filter(Boolean).slice(0, 2),
      }
    }
  }
  return snapshot
}

export function diffSnapshots(previous = {}, next = {}) {
  const added = []
  const updated = []
  const removed = []

  for (const [key, entry] of Object.entries(next)) {
    if (!previous[key]) added.push(entry)
    else if (signature(previous[key]) !== signature(entry)) updated.push({ before: previous[key], after: entry })
  }
  for (const [key, entry] of Object.entries(previous)) {
    if (!next[key]) removed.push(entry)
  }

  // A recreated bank (or an entry moved between banks) changes the key while the
  // topic stays the same. Pair those instead of reporting add plus remove for the
  // same conclusion, which would tell the model its fresh memory is now invalid.
  for (const entry of [...added]) {
    const index = removed.findIndex((candidate) => candidate.topic === entry.topic)
    if (index < 0) continue
    const before = removed[index]
    removed.splice(index, 1)
    added.splice(added.indexOf(entry), 1)
    if (signature(before) !== signature(entry)) updated.push({ before, after: entry })
  }

  return { added, updated, removed }
}

/**
 * What the model can actually see. Pinning, detail edits and timestamp bumps
 * must not produce a "the old conclusion is invalid" notice.
 */
function signature(entry) {
  return [entry.kind, entry.claim, JSON.stringify(entry.reasons ?? [])].join('\u0000')
}

export function hasChanges(diff) {
  return diff.added.length + diff.updated.length + diff.removed.length > 0
}

/** Change notice text for the diff since the last injected snapshot. */
export function renderDiff(diff) {
  const blocks = []
  for (const change of diff.updated) {
    const reason = change.after.reasons?.[0] ?? change.before.reasons?.[0]
    blocks.push(
      [
        `记忆更新：${change.after.topic}`,
        `新结论：${escapeMemoryText(change.after.claim)}`,
        `已失效：${escapeMemoryText(change.before.claim)}${reason ? `（原因：${escapeMemoryText(reason)}）` : ''} —— 不要再建议该方案。`,
      ].join('\n'),
    )
  }
  for (const change of diff.added) {
    blocks.push(`记忆新增：${change.topic} — ${escapeMemoryText(change.claim)}`)
  }
  for (const change of diff.removed) {
    blocks.push(`记忆废止：${change.topic} —— 该结论已不再适用，不要据此作答。`)
  }
  return blocks.join('\n\n')
}
