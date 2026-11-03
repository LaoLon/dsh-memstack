/** First-request index and change notices, injected through `agent/pre-step`. */

import { createHash, randomUUID } from 'node:crypto'
import { renderIndex, wrapReminder } from './render.js'
import { diffSnapshots, hasChanges, renderDiff, snapshotOf } from './sync.js'

export const SOURCE_KIND = 'memstack'

/** Plain user message: identical in shape to createUserMessage() from dsh-llm. */
export function createMemoryMessage(text, source) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: SOURCE_KIND, form: 'memory', ...source },
  }
}

/** Finds the last memory message in this session, so resume never double-injects. */
export function lastInjection(session) {
  const nodes = session?.surface?.nodes ?? []
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const event = session.eventAt?.(nodes[index])
    if (event?.type === 'user/message' && event.data?.source?.kind === SOURCE_KIND) return event.data.source
  }
  return null
}

export function identityOf(bankIds, snapshot) {
  const payload = JSON.stringify({ bankIds: [...bankIds].sort(), snapshot })
  return createHash('sha1').update(payload).digest('hex').slice(0, 16)
}

export function registerInjection(ctx, runtime) {
  const { config } = runtime

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!config.injectIndex || decision?.kind === 'reject') return decision

    try {
      const { agent, messages, signal } = payload
      const session = agent?.session
      if (!session) return decision

      const ready = await runtime.ready()
      if (ready === false) return decision
      await runtime.refresh?.()

      const bankIds = await runtime.recallBankIds(agent, signal)
      if (bankIds.length === 0) return decision

      const store = runtime.store
      const snapshot = snapshotOf(store, bankIds)
      const previous = lastInjection(session)

      if (!previous && Object.keys(snapshot).length === 0) return decision

      let text
      let includedIds = []
      if (!previous) {
        const rendered = renderIndex(store.toJSON(), {
          bankIds,
          maxBytes: config.indexByteBudget,
          topK: config.recallTopK,
          discoverabilityBudget: config.discoverabilityBudget,
          now: new Date(),
        })
        text = wrapReminder(rendered.text)
        includedIds = rendered.includedIds
      } else {
        const diff = diffSnapshots(previous.entries ?? {}, snapshot)
        if (!hasChanges(diff)) return decision
        text = wrapReminder(renderDiff(diff))
      }

      const message = createMemoryMessage(text, {
        baseline: !previous,
        identity: identityOf(bankIds, snapshot),
        entries: snapshot,
      })
      const anchor = decision.messages.findLastIndex((item) => messages.includes(item))
      const at = anchor >= 0 ? anchor : decision.messages.length - 1
      const spliced = decision.messages.toSpliced(at + 1, 0, message)
      // Surfacing a memory is a recall: it earns a little stability, once per index injection.
      if (includedIds.length) await runtime.reinforce?.(includedIds)
      return { ...decision, messages: spliced }
    } catch (error) {
      ctx.logger?.warn?.('memstack: memory injection failed: %o', error)
      return decision
    }
  })
}
