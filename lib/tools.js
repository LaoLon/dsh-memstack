/** Model-facing tools. Registered as plain definitions: no DSH imports needed. */

import { ENTRY_KINDS, RELATION_TYPES } from './store.js'

const writeParameters = {
  type: 'object',
  properties: {
    topic: { type: 'string', description: 'Stable dotted topic key, e.g. spdk.ingest-path. Reuse the same key to replace an older conclusion.' },
    kind: { type: 'string', enum: ENTRY_KINDS, description: 'decision | constraint | gotcha | preference | open-question' },
    claim: { type: 'string', description: 'The current conclusion in one sentence (<= 120 chars).' },
    detail: { type: 'string', description: 'Why it holds and how it was verified.' },
    rejected: {
      type: 'array',
      description: 'Approaches that were tried and ruled out, with the reason. This prevents the model from suggesting them again.',
      items: {
        type: 'object',
        properties: { option: { type: 'string' }, reason: { type: 'string' } },
        required: ['option'],
        additionalProperties: false,
      },
    },
    confidence: { type: 'string', enum: ['verified', 'tentative'] },
    pin: { type: 'boolean', description: 'Keep this entry in the injected index even under budget pressure.' },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description: 'Up to 8 lowercase tags for cross-topic discovery, e.g. ["spdk", "storage"].',
    },
    bank: { type: 'string', description: 'Bank id or title. Defaults to this workspace bank; use "global" for cross-project preferences.' },
  },
  required: ['topic', 'claim'],
  additionalProperties: false,
}

const writeOutput = {
  schema: {
    type: 'object',
    properties: {
      result: { type: 'string', enum: ['created', 'superseded', 'duplicate'] },
      topic: { type: 'string' },
      claim: { type: 'string' },
      previous: { type: 'string' },
    },
    required: ['result', 'topic', 'claim'],
    additionalProperties: false,
  },
  render(_args, value) {
    const text =
      value.result === 'created'
        ? `已记住 ${value.topic}：${value.claim}`
        : value.result === 'superseded'
          ? `已更新 ${value.topic}：${value.claim}\n旧结论已标记为失效：${value.previous ?? ''}`
          : `已存在相同记忆，未重复写入：${value.topic}`
    return [{ type: 'text', text }]
  },
}

function retentionText(entry) {
  const percent = Math.round(Number(entry.retention ?? 0) * 100)
  const stage = entry.stage ? `/${entry.stage}` : ''
  return `留存 ${percent}%${stage}`
}

/** Drops null/undefined so optional fields stay absent instead of failing a type check. */
function prune(value) {
  if (Array.isArray(value)) return value.map(prune).filter((item) => item !== undefined)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      const next = prune(item)
      if (next !== undefined) out[key] = next
    }
    return out
  }
  return value ?? undefined
}

/**
 * Projects the library view onto exactly the fields `memory_read` declares.
 * The Host rejects any returned field the output schema does not list, so this
 * projection and that schema have to move together.
 */
function readView(view) {
  const ref = (value) => (value ? { id: value.id, topic: value.topic, claim: value.claim, status: value.status } : undefined)
  return prune({
    id: view.id,
    bankId: view.bankId,
    bankTitle: view.bankTitle,
    topic: view.topic,
    kind: view.kind,
    claim: view.claim,
    detail: view.detail,
    confidence: view.confidence,
    status: view.status,
    pinned: view.pinned,
    tags: view.tags,
    rejected: view.rejected,
    relations: (view.relations ?? []).map((relation) => ({ type: relation.type, note: relation.note, target: ref(relation.target) })),
    incomingRelations: (view.incomingRelations ?? []).map((relation) => ({
      type: relation.type,
      note: relation.note,
      source: ref(relation.source),
    })),
    retention: view.retention,
    stage: view.stage,
    stabilityDays: view.stabilityDays,
    ageDays: view.ageDays,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    lastReviewedAt: view.lastReviewedAt,
    lastRecalledAt: view.lastRecalledAt,
    reviewCount: view.reviewCount,
    recalledCount: view.recalledCount,
    nextReviewAt: view.nextReviewAt,
    supersedes: ref(view.supersedes),
    supersededBy: ref(view.supersededBy),
    chain: (view.chain ?? []).map((item) => ({
      id: item.id,
      topic: item.topic,
      claim: item.claim,
      status: item.status,
      updatedAt: item.updatedAt,
    })),
  })
}

function searchOutput() {
  return {
    schema: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          bankId: { type: 'string' },
          bankTitle: { type: 'string' },
          id: { type: 'string' },
          topic: { type: 'string' },
          claim: { type: 'string' },
          kind: { type: 'string' },
          status: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          pinned: { type: 'boolean' },
          retention: { type: 'number' },
          stage: { type: 'string' },
          stale: { type: 'boolean' },
          updatedAt: { type: 'string' },
        },
        required: ['bankId', 'topic', 'claim'],
        additionalProperties: false,
      },
    },
    render(_args, value) {
      if (!value.length) return [{ type: 'text', text: '没有匹配的记忆。' }]
      const text = value
        .map(
          (entry) =>
            `[${entry.bankTitle}] ${entry.topic}（${entry.kind}/${entry.status}，${retentionText(entry)}${entry.pinned ? '，固定' : ''}${entry.stale ? '，可能过时' : ''}）— ${entry.claim}`,
        )
        .join('\n')
      return [{ type: 'text', text }]
    },
  }
}

function prepare(runtime) {
  return Promise.resolve(runtime.ready?.()).then(() => runtime.refresh?.())
}

export function memoryTools(runtime) {
  return [
    {
      name: 'memory_write',
      description:
        'Record a durable project judgment in the workspace memory bank. Write only for a decision, constraint, gotcha, or preference that cannot be re-derived from the repository. Reusing an existing topic replaces the old conclusion, so always record what was ruled out in `rejected` with the reason. Do not record file lists, signatures, or progress notes.',
      parameters: writeParameters,
      output: writeOutput,
      async execute(args, exec) {
        await prepare(runtime)
        const store = runtime.store
        const bankId = await runtime.bankFor(exec?.agent, args.bank, exec?.signal)
        const outcome = store.writeEntry({
          bankId,
          topic: args.topic,
          kind: args.kind ?? 'decision',
          claim: args.claim,
          detail: args.detail ?? '',
          rejected: args.rejected ?? [],
          confidence: args.confidence ?? 'verified',
          pin: args.pin ?? false,
          tags: args.tags ?? [],
          source: { sessionId: exec?.agent?.session?.id },
        })
        if (outcome.result !== 'duplicate') await runtime.commit()
        return {
          result: outcome.result,
          topic: outcome.entry.topic,
          claim: outcome.entry.claim,
          ...(outcome.previous ? { previous: outcome.previous.claim } : {}),
        }
      },
    },
    {
      name: 'memory_search',
      description:
        'Search recorded memory across the banks this session may query. Use it before assuming a past decision, and to check whether a topic is already recorded. Results include retention: a low percentage means the memory has not been reviewed for a long time and should be confirmed with the user before relying on it.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords matched against topic, claim, detail, tags and rejected options.' },
          bank: { type: 'string', description: 'Limit to one bank id or title.' },
          limit: { type: 'number', description: 'Maximum results, default 20.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: searchOutput(),
      async execute(args, exec) {
        await prepare(runtime)
        const limit = Math.min(50, Math.max(1, Math.trunc(Number(args.limit) || 20)))
        return runtime.search(args.query, args.bank, limit, exec?.agent)
      },
    },
    {
      name: 'memory_read',
      description:
        'Read one memory entry in full: claim, detail, rejected approaches, tags, relations, retention and its supersede history.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string' },
          id: { type: 'string' },
          bank: { type: 'string' },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            bankId: { type: 'string' },
            bankTitle: { type: 'string' },
            topic: { type: 'string' },
            kind: { type: 'string' },
            claim: { type: 'string' },
            detail: { type: 'string' },
            confidence: { type: 'string' },
            status: { type: 'string' },
            pinned: { type: 'boolean' },
            tags: { type: 'array', items: { type: 'string' } },
            rejected: {
              type: 'array',
              items: {
                type: 'object',
                properties: { option: { type: 'string' }, reason: { type: 'string' } },
                additionalProperties: false,
              },
            },
            relations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string' },
                  note: { type: 'string' },
                  target: {
                    type: 'object',
                    properties: { id: { type: 'string' }, topic: { type: 'string' }, claim: { type: 'string' }, status: { type: 'string' } },
                    additionalProperties: false,
                  },
                },
                additionalProperties: false,
              },
            },
            incomingRelations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string' },
                  note: { type: 'string' },
                  source: {
                    type: 'object',
                    properties: { id: { type: 'string' }, topic: { type: 'string' }, claim: { type: 'string' }, status: { type: 'string' } },
                    additionalProperties: false,
                  },
                },
                additionalProperties: false,
              },
            },
            retention: { type: 'number' },
            stage: { type: 'string' },
            stabilityDays: { type: 'number' },
            ageDays: { type: 'number' },
            createdAt: { type: 'string' },
            updatedAt: { type: 'string' },
            lastReviewedAt: { type: 'string' },
            lastRecalledAt: { type: 'string' },
            reviewCount: { type: 'number' },
            recalledCount: { type: 'number' },
            nextReviewAt: { type: 'string' },
            supersedes: {
              type: 'object',
              properties: { id: { type: 'string' }, topic: { type: 'string' }, claim: { type: 'string' }, status: { type: 'string' } },
              additionalProperties: false,
            },
            supersededBy: {
              type: 'object',
              properties: { id: { type: 'string' }, topic: { type: 'string' }, claim: { type: 'string' }, status: { type: 'string' } },
              additionalProperties: false,
            },
            chain: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  topic: { type: 'string' },
                  claim: { type: 'string' },
                  status: { type: 'string' },
                  updatedAt: { type: 'string' },
                },
                additionalProperties: false,
              },
            },
          },
          required: ['topic', 'claim'],
          additionalProperties: false,
        },
        render(_args, value) {
          const lines = [`${value.topic}（${value.kind}，${value.status}，${retentionText(value)}）`, value.claim]
          if (value.tags?.length) lines.push(`标签：${value.tags.join(', ')}`)
          if (value.detail) lines.push('', value.detail)
          if (value.rejected?.length) {
            lines.push('', '已否决：')
            for (const item of value.rejected) lines.push(`- ${item.option}${item.reason ? `：${item.reason}` : ''}`)
          }
          if (value.relations?.length) {
            lines.push('', '关系：')
            for (const relation of value.relations) lines.push(`- ${relation.type} → ${relation.target?.topic ?? ''}`)
          }
          if (value.chain?.length > 1) {
            lines.push('', '取代链：')
            for (const item of value.chain) lines.push(`- [${item.status}] ${item.topic}：${item.claim}`)
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args, exec) {
        await prepare(runtime)
        const entry = runtime.read(args, exec?.agent)
        if (!entry) throw new Error(`memory entry not found: ${args.topic ?? args.id ?? '(no key)'}`)
        return readView(entry)
      },
    },
    {
      name: 'memory_forget',
      description:
        'Remove a recorded memory only when the user explicitly asks to forget or correct it. Default mode disables it (recoverable, stops injection); mode "delete" is permanent and restores the conclusion this entry had superseded.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Topic of the active entry to remove.' },
          id: { type: 'string', description: 'Entry id, when known from search results.' },
          bank: { type: 'string' },
          mode: { type: 'string', enum: ['archive', 'delete'] },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            result: { type: 'string', enum: ['archived', 'deleted'] },
            id: { type: 'string' },
            topic: { type: 'string' },
            claim: { type: 'string' },
            restored: { type: 'string' },
          },
          required: ['result', 'topic', 'claim'],
          additionalProperties: false,
        },
        render(_args, value) {
          const verb = value.result === 'archived' ? '已停用' : '已删除'
          const tail = value.restored ? `\n已恢复被它取代的旧结论：${value.restored}` : ''
          return [{ type: 'text', text: `${verb} ${value.topic}：${value.claim}${tail}` }]
        },
      },
      async execute(args, exec) {
        await prepare(runtime)
        const outcome = runtime.forget(args)
        if (!outcome) throw new Error(`memory entry not found: ${args.topic ?? args.id ?? '(no key)'}`)
        await runtime.commit()
        return outcome
      },
    },
    {
      name: 'memory_review',
      description:
        'Confirm a memory after the user has verified it. Use verdict "still-true" to reset its forgetting curve (it will be injected again with high confidence), or "outdated" to disable it. Never call this without the user confirming the conclusion.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string' },
          id: { type: 'string' },
          bank: { type: 'string' },
          verdict: { type: 'string', enum: ['still-true', 'outdated'] },
        },
        required: ['verdict'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            result: { type: 'string', enum: ['reviewed', 'archived'] },
            topic: { type: 'string' },
            claim: { type: 'string' },
            retention: { type: 'number' },
            stage: { type: 'string' },
          },
          required: ['result', 'topic', 'claim'],
          additionalProperties: false,
        },
        render(_args, value) {
          const text =
            value.result === 'reviewed'
              ? `已复习 ${value.topic}：${value.claim}\n留存率重置为 ${Math.round((value.retention ?? 1) * 100)}%。`
              : `已停用过时记忆 ${value.topic}：${value.claim}`
          return [{ type: 'text', text }]
        },
      },
      async execute(args, exec) {
        await prepare(runtime)
        const outcome = await runtime.review(args)
        if (!outcome) throw new Error(`memory entry not found: ${args.topic ?? args.id ?? '(no key)'}`)
        return outcome
      },
    },
    {
      name: 'memory_relate',
      description:
        'Create or remove a relation between two memories, e.g. a new decision that refines an older one, or two conclusions that contradict. Relations show up in the graph view and help future sessions find connected judgments.',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Source entry topic or id.' },
          target: { type: 'string', description: 'Target entry topic or id.' },
          type: { type: 'string', enum: RELATION_TYPES },
          note: { type: 'string', description: 'Why the two are related.' },
          remove: { type: 'boolean', description: 'Remove the relation instead of creating it.' },
        },
        required: ['source', 'target'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            from: { type: 'string' },
            to: { type: 'string' },
            type: { type: 'string' },
            removed: { type: 'boolean' },
          },
          required: ['from', 'to', 'type'],
          additionalProperties: false,
        },
        render(_args, value) {
          return [
            {
              type: 'text',
              text: value.removed
                ? `已移除关系：${value.from} → ${value.to}`
                : `已建立关系：${value.from} —${value.type}→ ${value.to}`,
            },
          ]
        },
      },
      async execute(args) {
        await prepare(runtime)
        const outcome = await runtime.relate({
          from: keyArgs(args.source),
          to: keyArgs(args.target),
          type: args.type,
          note: args.note,
          remove: args.remove,
        })
        if (!outcome) throw new Error(`memory entry not found: ${args.source} / ${args.target}`)
        return {
          from: outcome.from.topic,
          to: outcome.to.topic,
          type: outcome.type,
          removed: outcome.removed,
        }
      },
    },
    {
      name: 'memory_inventory',
      description:
        'List recorded memories grouped by bank, including superseded and archived history and each entry’s retention. Use when the user asks what is remembered or which banks exist.',
      parameters: {
        type: 'object',
        properties: { bank: { type: 'string', description: 'Limit to one bank id or title.' } },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              bankId: { type: 'string' },
              bankTitle: { type: 'string' },
              id: { type: 'string' },
              topic: { type: 'string' },
              claim: { type: 'string' },
              kind: { type: 'string' },
              status: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
              retention: { type: 'number' },
              stage: { type: 'string' },
              stabilityDays: { type: 'number' },
              pinned: { type: 'boolean' },
              updatedAt: { type: 'string' },
            },
            required: ['bankTitle', 'topic', 'claim', 'status'],
            additionalProperties: false,
          },
        },
        render(_args, value) {
          if (!value.length) return [{ type: 'text', text: '记忆库为空。' }]
          const statusLabel = { active: '生效', superseded: '已取代', archived: '已停用', candidate: '候选' }
          const lines = []
          let current = null
          for (const row of value) {
            if (row.bankTitle !== current) {
              current = row.bankTitle
              lines.push(`【${row.bankTitle}】`)
            }
            lines.push(
              `  ${row.topic}（${row.kind}/${statusLabel[row.status] ?? row.status}，${retentionText(row)}${row.pinned ? '，固定' : ''}）— ${row.claim}`,
            )
          }
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args) {
        await prepare(runtime)
        return runtime.inventory(args ?? {})
      },
    },
  ]
}

function keyArgs(value) {
  const text = String(value ?? '').trim()
  if (!text) return {}
  // Entry ids are short and prefixed; anything else is treated as a topic.
  return /^entry_[A-Za-z0-9]+$/.test(text) ? { id: text } : { topic: text }
}
