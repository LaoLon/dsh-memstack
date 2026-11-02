/** Model-facing tools. Registered as plain definitions: no DSH imports needed. */

import { ENTRY_KINDS } from './store.js'

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
          updatedAt: { type: 'string' },
        },
        required: ['bankId', 'topic', 'claim'],
        additionalProperties: false,
      },
    },
    render(_args, value) {
      if (!value.length) return [{ type: 'text', text: '没有匹配的记忆。' }]
      const text = value
        .map((entry) => `[${entry.bankTitle}] ${entry.topic}（${entry.kind}/${entry.status}）— ${entry.claim}`)
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
        'Search recorded memory across the banks this session may query. Use it before assuming a past decision, and to check whether a topic is already recorded.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords matched against topic, claim, detail and rejected options.' },
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
      description: 'Read one memory entry in full, including rejected approaches and its supersede history.',
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
            topic: { type: 'string' },
            kind: { type: 'string' },
            claim: { type: 'string' },
            detail: { type: 'string' },
            confidence: { type: 'string' },
            status: { type: 'string' },
            updatedAt: { type: 'string' },
          },
          required: ['topic', 'claim'],
          additionalProperties: false,
        },
        render(_args, value) {
          const lines = [`${value.topic}（${value.kind}，${value.status}）`, value.claim]
          if (value.detail) lines.push('', value.detail)
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(args, exec) {
        await prepare(runtime)
        const entry = runtime.read(args, exec?.agent)
        if (!entry) throw new Error(`memory entry not found: ${args.topic ?? args.id ?? '(no key)'}`)
        return entry
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
      name: 'memory_inventory',
      description:
        'List recorded memories grouped by bank, including superseded and archived history. Use when the user asks what is remembered or which banks exist.',
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
              topic: { type: 'string' },
              claim: { type: 'string' },
              kind: { type: 'string' },
              status: { type: 'string' },
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
            lines.push(`  ${row.topic}（${row.kind}/${statusLabel[row.status] ?? row.status}）— ${row.claim}`)
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
