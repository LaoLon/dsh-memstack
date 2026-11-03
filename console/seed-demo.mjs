/** Deterministic demo state: realistic memories spread across banks, ages and retention stages. */

const DAY = 86_400_000

export function createDemoState({ now = new Date() } = {}) {
  const nowMs = new Date(now).getTime()
  const at = (daysAgo) => new Date(nowMs - daysAgo * DAY).toISOString()

  const banks = {}
  const entries = {}
  const links = {}

  const addBank = (spec) => {
    banks[spec.id] = {
      id: spec.id,
      kind: spec.kind,
      title: spec.title,
      description: spec.description ?? '',
      workspaceIds: spec.workspaceIds ?? [],
      createdAt: at(spec.createdDaysAgo ?? 420),
      updatedAt: at(spec.updatedDaysAgo ?? 1),
      ...(spec.archivedAt ? { archivedAt: spec.archivedAt } : {}),
    }
    return banks[spec.id]
  }

  const addEntry = (spec) => {
    const kind = spec.kind ?? 'decision'
    const stability = spec.stabilityDays ?? { decision: 60, constraint: 90, gotcha: 90, preference: 120, 'open-question': 14 }[kind]
    const entry = {
      id: spec.id,
      bankId: spec.bankId,
      topic: spec.topic,
      kind,
      claim: spec.claim,
      detail: spec.detail ?? '',
      rejected: spec.rejected ?? [],
      status: spec.status ?? 'active',
      confidence: spec.confidence ?? 'verified',
      pinned: Boolean(spec.pinned),
      tags: spec.tags ?? [],
      relations: [],
      recalledCount: spec.recalledCount ?? 3,
      reviewCount: spec.reviewCount ?? 1,
      stabilityDays: stability,
      lastReviewedAt: at(spec.reviewedDaysAgo ?? spec.createdDaysAgo ?? 30),
      lastRecalledAt: at(spec.recalledDaysAgo ?? Math.max(0, (spec.reviewedDaysAgo ?? 30) - 5)),
      createdAt: at(spec.createdDaysAgo ?? 30),
      updatedAt: at(spec.updatedDaysAgo ?? spec.createdDaysAgo ?? 30),
      source: { sessionId: `sess_demo_${spec.id.slice(-4)}` },
      ...(spec.archivedAt ? { archivedAt: spec.archivedAt, archivedFrom: spec.archivedFrom ?? 'active' } : {}),
      ...(spec.supersedes ? { supersedes: spec.supersedes } : {}),
      ...(spec.supersededBy ? { supersededBy: spec.supersededBy } : {}),
    }
    entries[entry.id] = entry
    return entry
  }

  const chain = (ids) => {
    for (let index = 0; index < ids.length; index += 1) {
      const entry = entries[ids[index]]
      if (!entry) continue
      if (index > 0) {
        entry.supersedes = ids[index - 1]
        entry.status = 'superseded'
      }
      if (index < ids.length - 1) {
        entry.supersededBy = ids[index + 1]
        entry.supersededAt = entries[ids[index + 1]].createdAt
        entry.updatedAt = entry.supersededAt
      }
    }
    entries[ids[ids.length - 1]].status = 'active'
    delete entries[ids[ids.length - 1]].supersededAt
    delete entries[ids[ids.length - 1]].supersededBy
  }

  const relate = (fromId, targetId, type, note) => {
    const entry = entries[fromId]
    if (!entry) throw new Error(`demo: missing relation source ${fromId}`)
    entry.relations.push({ target: targetId, type, ...(note ? { note } : {}) })
  }

  // ---------------------------------------------------------------- banks

  addBank({
    id: 'bank_demo_spdk',
    kind: 'workspace',
    title: 'spdk-storage',
    description: '基于 SPDK 的存储引擎：设备接入、性能基线、构建链',
    workspaceIds: ['ws-demo-spdk'],
    createdDaysAgo: 420,
  })
  addBank({
    id: 'bank_demo_dsh',
    kind: 'workspace',
    title: 'dsh-harness',
    description: 'DSH 插件开发：Host/Client 入口、注入链路与存储',
    workspaceIds: ['ws-demo-dsh'],
    createdDaysAgo: 390,
  })
  addBank({
    id: 'bank_demo_win',
    kind: 'topic',
    title: 'windows-sandbox',
    description: 'Windows 沙箱、ACL 与路径权限的踩坑记录',
    createdDaysAgo: 300,
  })
  addBank({
    id: 'bank_demo_eval',
    kind: 'topic',
    title: '模型评测',
    description: '离线评测集、judge 偏差与成本',
    createdDaysAgo: 240,
  })
  addBank({
    id: 'bank_demo_global',
    kind: 'global',
    title: '全局偏好',
    description: '跨项目的长期偏好与约定',
    createdDaysAgo: 420,
  })
  addBank({
    id: 'bank_demo_legacy',
    kind: 'workspace',
    title: '旧项目 · legacy',
    description: '已结束项目的结论，保留备查',
    workspaceIds: ['ws-demo-legacy'],
    createdDaysAgo: 500,
    archivedAt: at(30),
  })

  // ---------------------------------------------------------------- SPDK

  addEntry({
    id: 'entry_demo_ingest_old',
    bankId: 'bank_demo_spdk',
    topic: 'spdk.ingest-path',
    kind: 'decision',
    claim: '通过 pre_load 钩子把设备句柄注入存储进程',
    detail: '最初的方案，想复用 SPDK 的启动钩子，避免额外进程。',
    rejected: [{ option: 'pre_load 注入', reason: '实测目标时机拿不到设备句柄' }],
    tags: ['spdk', 'ingest'],
    createdDaysAgo: 210,
    reviewedDaysAgo: 210,
    supersededBy: 'entry_demo_ingest',
    status: 'superseded',
    stabilityDays: 25,
  })
  addEntry({
    id: 'entry_demo_ingest',
    bankId: 'bank_demo_spdk',
    topic: 'spdk.ingest-path',
    kind: 'decision',
    claim: '独立守护进程通过共享内存向存储进程交付设备句柄',
    detail:
      '守护进程在启动早期枚举并绑定设备，把句柄和 BAR 信息写入共享内存；存储进程只读消费。已在两台机器上验证。',
    rejected: [
      { option: 'pre_load 注入', reason: '目标时机拿不到设备句柄' },
      { option: '内核模块回调', reason: '需要重新编译内核，部署成本过高' },
    ],
    tags: ['spdk', 'ingest', 'shm'],
    pinned: true,
    createdDaysAgo: 180,
    reviewedDaysAgo: 12,
    stabilityDays: 90,
    recalledCount: 14,
    reviewCount: 3,
    supersedes: 'entry_demo_ingest_old',
  })
  addEntry({
    id: 'entry_demo_shm',
    bankId: 'bank_demo_spdk',
    topic: 'spdk.shm-protocol',
    kind: 'constraint',
    claim: '共享内存协议固定 64 字节头，双方版本号必须一致，否则拒绝启动',
    detail: '头部保留 8 字节 magic、4 字节版本、4 字节长度；升级协议必须同时更新两端。',
    tags: ['spdk', 'shm', 'protocol'],
    createdDaysAgo: 175,
    reviewedDaysAgo: 40,
    stabilityDays: 120,
  })
  addEntry({
    id: 'entry_demo_dpdk',
    bankId: 'bank_demo_spdk',
    topic: 'spdk.dpdk-version',
    kind: 'constraint',
    claim: '锁定 DPDK 23.11，不跟随主线升级',
    detail: '24.03 改动了 vfio 绑定时序，目标机器上会丢设备。等 25.x LTS 再做回归。',
    rejected: [{ option: '升级到 24.03', reason: 'vfio 绑定时序变化，实测丢设备' }],
    tags: ['spdk', 'dpdk', 'version'],
    createdDaysAgo: 300,
    reviewedDaysAgo: 200,
    stabilityDays: 90,
    recalledCount: 2,
  })
  addEntry({
    id: 'entry_demo_hugepage',
    bankId: 'bank_demo_spdk',
    topic: 'spdk.hugepage',
    kind: 'gotcha',
    claim: '启动前必须预分配 2MB hugepage，否则 EAL 初始化会静默降级',
    detail: '没有 hugepage 时 EAL 不报错，但 IO 性能掉到十分之一，表现为"随机变慢"。',
    tags: ['spdk', 'linux', 'memory'],
    createdDaysAgo: 150,
    reviewedDaysAgo: 65,
    stabilityDays: 90,
  })
  addEntry({
    id: 'entry_demo_vfio',
    bankId: 'bank_demo_spdk',
    topic: 'spdk.vfio-binding',
    kind: 'gotcha',
    claim: 'vfio-pci 绑定后要重启容器网络命名空间，否则设备在新命名空间里不可见',
    tags: ['spdk', 'linux', 'vfio'],
    createdDaysAgo: 130,
    reviewedDaysAgo: 9,
    stabilityDays: 60,
    recalledCount: 8,
  })
  addEntry({
    id: 'entry_demo_perf',
    bankId: 'bank_demo_spdk',
    topic: 'spdk.perf-baseline',
    kind: 'decision',
    claim: '以 4K 随机读 180 万 IOPS 作为回归基线，波动超过 8% 即判失败',
    tags: ['spdk', 'perf'],
    createdDaysAgo: 90,
    reviewedDaysAgo: 20,
    stabilityDays: 45,
  })
  addEntry({
    id: 'entry_demo_build',
    bankId: 'bank_demo_spdk',
    topic: 'spdk.build-toolchain',
    kind: 'constraint',
    claim: '统一用 clang 18 + lld 构建，gcc 会触发 DPDK 的警告即错误',
    tags: ['spdk', 'build'],
    createdDaysAgo: 80,
    reviewedDaysAgo: 75,
    stabilityDays: 120,
  })
  addEntry({
    id: 'entry_demo_ci',
    bankId: 'bank_demo_spdk',
    topic: 'spdk.ci-runner',
    kind: 'gotcha',
    claim: 'CI runner 必须打 exclusive 标记，否则并发用例会抢占 hugepage',
    tags: ['spdk', 'ci'],
    createdDaysAgo: 60,
    reviewedDaysAgo: 55,
    stabilityDays: 90,
  })

  // ---------------------------------------------------------------- DSH

  addEntry({
    id: 'entry_demo_inject_old',
    bankId: 'bank_demo_dsh',
    topic: 'dsh.inject.pre-step',
    kind: 'decision',
    claim: '用 agent.inject() 在下一轮追加记忆索引',
    rejected: [{ option: 'agent.inject()', reason: '与 batch 顺序不一致，偶发丢消息' }],
    tags: ['dsh', 'inject'],
    createdDaysAgo: 200,
    reviewedDaysAgo: 200,
    stabilityDays: 30,
    supersededBy: 'entry_demo_inject',
    status: 'superseded',
  })
  addEntry({
    id: 'entry_demo_inject',
    bankId: 'bank_demo_dsh',
    topic: 'dsh.inject.pre-step',
    kind: 'decision',
    claim: '在 agent/pre-step 里把 sourced 用户消息 toSpliced 进本轮请求',
    detail:
      '复刻 dsh-agent-instructions 的范式：next() 之后组消息，插到最后一条已认领消息之后。会话内查重走 session.surface.nodes。',
    rejected: [{ option: 'agent.inject()', reason: '与 batch 顺序不一致，偶发丢消息' }],
    tags: ['dsh', 'inject', 'kv-cache'],
    pinned: true,
    createdDaysAgo: 190,
    reviewedDaysAgo: 3,
    stabilityDays: 120,
    recalledCount: 21,
    reviewCount: 4,
    supersedes: 'entry_demo_inject_old',
  })
  addEntry({
    id: 'entry_demo_host_api',
    bankId: 'bank_demo_dsh',
    topic: 'dsh.plugin.host-api',
    kind: 'constraint',
    claim: 'Host 插件是 ESM 的 apply(ctx, config)，工具可以直接注册普通对象',
    detail: 'register() 只校验 output.{schema,render} 与 timeoutMs，不需要 defineTool。',
    tags: ['dsh', 'plugin', 'host'],
    createdDaysAgo: 185,
    reviewedDaysAgo: 10,
    stabilityDays: 180,
  })
  addEntry({
    id: 'entry_demo_client_bundle',
    bankId: 'bank_demo_dsh',
    topic: 'dsh.plugin.client-bundle',
    kind: 'constraint',
    claim: 'Client 入口是手写 __ModuleLoader__ bundle，不需要构建步骤',
    tags: ['dsh', 'plugin', 'client'],
    createdDaysAgo: 180,
    reviewedDaysAgo: 30,
    stabilityDays: 120,
  })
  addEntry({
    id: 'entry_demo_storage',
    bankId: 'bank_demo_dsh',
    topic: 'dsh.storage.json',
    kind: 'gotcha',
    claim: 'Console 与 Host 同时写 state.json 会互相覆盖，必须按 mtime 重载',
    detail: '外部改动在下一个工具调用前 stat 对比 mtime，发现更新则整体重载。',
    tags: ['dsh', 'storage', 'concurrency'],
    createdDaysAgo: 100,
    reviewedDaysAgo: 4,
    stabilityDays: 60,
  })
  addEntry({
    id: 'entry_demo_hmr',
    bankId: 'bank_demo_dsh',
    topic: 'dsh.hooks.hmr',
    kind: 'gotcha',
    claim: 'Host 代码改动需要热重组或重启，Client 改动刷新页面即可',
    tags: ['dsh', 'hmr'],
    createdDaysAgo: 95,
    reviewedDaysAgo: 90,
    stabilityDays: 45,
  })
  addEntry({
    id: 'entry_demo_workspace',
    bankId: 'bank_demo_dsh',
    topic: 'dsh.workspace-resolution',
    kind: 'decision',
    claim: '用 workspaceRegistry.resolveByPath(cwd) 解析工作区 id，失败时退化为目录路径',
    tags: ['dsh', 'workspace'],
    createdDaysAgo: 88,
    reviewedDaysAgo: 85,
    stabilityDays: 60,
  })

  // ---------------------------------------------------------------- Windows

  addEntry({
    id: 'entry_demo_acl_old',
    bankId: 'bank_demo_win',
    topic: 'win.sandbox.acl',
    kind: 'decision',
    claim: '沙箱拒绝访问时先关闭 Defender 实时保护再重试',
    rejected: [{ option: '关闭 Defender', reason: '与故障无关，还会掩盖真实的 ACL 问题' }],
    tags: ['windows', 'sandbox'],
    createdDaysAgo: 120,
    reviewedDaysAgo: 120,
    stabilityDays: 20,
    supersededBy: 'entry_demo_acl',
    status: 'superseded',
  })
  addEntry({
    id: 'entry_demo_acl',
    bankId: 'bank_demo_win',
    topic: 'win.sandbox.acl',
    kind: 'decision',
    claim: '先检查目标路径各级 ACL 是否丢了继承，再决定修复范围',
    detail: '典型现象是父目录可写、子目录被显式拒绝。逐级 Get-Acl 比对继承标记，只修丢失的那一级。',
    rejected: [{ option: '关闭 Defender', reason: '与故障无关，还会掩盖真实的 ACL 问题' }],
    tags: ['windows', 'sandbox', 'acl'],
    pinned: true,
    createdDaysAgo: 110,
    reviewedDaysAgo: 2,
    stabilityDays: 180,
    recalledCount: 18,
    reviewCount: 5,
    supersedes: 'entry_demo_acl_old',
  })
  addEntry({
    id: 'entry_demo_longpath',
    bankId: 'bank_demo_win',
    topic: 'win.path-long',
    kind: 'gotcha',
    claim: '路径超过 260 字符时 Node 的 rename 会失败，原子写要使用长路径前缀',
    tags: ['windows', 'fs'],
    createdDaysAgo: 70,
    reviewedDaysAgo: 60,
    stabilityDays: 90,
  })
  addEntry({
    id: 'entry_demo_processtree',
    bankId: 'bank_demo_win',
    topic: 'win.process-tree',
    kind: 'decision',
    claim: '结束子进程要按进程树 kill，否则 Electron 的 node 子进程会残留',
    tags: ['windows', 'process'],
    createdDaysAgo: 50,
    reviewedDaysAgo: 45,
    stabilityDays: 60,
  })
  addEntry({
    id: 'entry_demo_encoding',
    bankId: 'bank_demo_win',
    topic: 'win.console-encoding',
    kind: 'gotcha',
    claim: 'PowerShell 读取 UTF-8 JSON 显示乱码是控制台编码问题，不是文件损坏',
    tags: ['windows', 'encoding'],
    createdDaysAgo: 40,
    reviewedDaysAgo: 5,
    stabilityDays: 120,
    recalledCount: 6,
  })

  // ---------------------------------------------------------------- 评测

  addEntry({
    id: 'entry_demo_dataset',
    bankId: 'bank_demo_eval',
    topic: 'eval.dataset-drift',
    kind: 'decision',
    claim: '固定评测集版本，更新数据集必须同步更新基线分',
    tags: ['eval', 'dataset'],
    createdDaysAgo: 60,
    reviewedDaysAgo: 15,
    stabilityDays: 60,
  })
  addEntry({
    id: 'entry_demo_prompt',
    bankId: 'bank_demo_eval',
    topic: 'eval.prompt-version',
    kind: 'constraint',
    claim: 'prompt 版本号写进结果文件名，否则无法复现',
    tags: ['eval', 'prompt'],
    createdDaysAgo: 55,
    reviewedDaysAgo: 50,
    stabilityDays: 90,
  })
  addEntry({
    id: 'entry_demo_judge',
    bankId: 'bank_demo_eval',
    topic: 'eval.judge-bias',
    kind: 'gotcha',
    claim: 'LLM judge 对长答案有系统性偏好，必须按长度分层看分',
    tags: ['eval', 'judge'],
    createdDaysAgo: 45,
    reviewedDaysAgo: 35,
    stabilityDays: 60,
  })
  addEntry({
    id: 'entry_demo_cost',
    bankId: 'bank_demo_eval',
    topic: 'eval.cost-budget',
    kind: 'open-question',
    claim: '是否把 8k 上下文评测换成 32k？成本增加 3.2 倍，收益尚未验证',
    tags: ['eval', 'cost'],
    confidence: 'tentative',
    createdDaysAgo: 30,
    reviewedDaysAgo: 25,
    stabilityDays: 14,
    recalledCount: 1,
  })

  // ---------------------------------------------------------------- 全局偏好

  addEntry({
    id: 'entry_demo_lang',
    bankId: 'bank_demo_global',
    topic: 'pref.language-zh',
    kind: 'preference',
    claim: '默认使用简体中文交流，技术名词保留英文',
    tags: ['preference', 'language'],
    pinned: true,
    createdDaysAgo: 250,
    reviewedDaysAgo: 1,
    stabilityDays: 365,
    reviewCount: 9,
  })
  addEntry({
    id: 'entry_demo_commit',
    bankId: 'bank_demo_global',
    topic: 'pref.commit-style',
    kind: 'preference',
    claim: '提交信息使用 conventional commits，正文用中文',
    tags: ['preference', 'git'],
    createdDaysAgo: 240,
    reviewedDaysAgo: 120,
    stabilityDays: 180,
  })
  addEntry({
    id: 'entry_demo_shell',
    bankId: 'bank_demo_global',
    topic: 'pref.shell',
    kind: 'preference',
    claim: '优先用 PowerShell 原生命令而不是 WSL，避免路径转换问题',
    tags: ['preference', 'windows'],
    createdDaysAgo: 200,
    reviewedDaysAgo: 150,
    stabilityDays: 120,
  })

  // ---------------------------------------------------------------- 旧项目

  addEntry({
    id: 'entry_demo_legacy_boot',
    bankId: 'bank_demo_legacy',
    topic: 'legacy.bootstrap',
    kind: 'decision',
    claim: '旧项目用 Windows 服务托管采集器，开机自启',
    tags: ['legacy'],
    createdDaysAgo: 400,
    reviewedDaysAgo: 380,
    status: 'archived',
    archivedAt: at(30),
    archivedFrom: 'active',
    stabilityDays: 60,
  })
  addEntry({
    id: 'entry_demo_legacy_conf',
    bankId: 'bank_demo_legacy',
    topic: 'legacy.config-path',
    kind: 'constraint',
    claim: '旧项目配置目录固定在 C:\\Legacy\\conf，不可迁移',
    tags: ['legacy', 'config'],
    createdDaysAgo: 390,
    reviewedDaysAgo: 370,
    status: 'archived',
    archivedAt: at(30),
    archivedFrom: 'active',
    stabilityDays: 90,
  })

  chain(['entry_demo_ingest_old', 'entry_demo_ingest'])
  chain(['entry_demo_inject_old', 'entry_demo_inject'])
  chain(['entry_demo_acl_old', 'entry_demo_acl'])

  // ---------------------------------------------------------------- relations

  relate('entry_demo_ingest', 'entry_demo_shm', 'depends', '设备交付依赖共享内存协议')
  relate('entry_demo_perf', 'entry_demo_dpdk', 'depends', '基线只在锁定的 DPDK 版本上有效')
  relate('entry_demo_ingest', 'entry_demo_vfio', 'related', '绑定顺序会影响设备交付')
  relate('entry_demo_hugepage', 'entry_demo_ci', 'related', '并发用例会抢占 hugepage')
  relate('entry_demo_inject', 'entry_demo_host_api', 'refines', '注入实现建立在 Host 插件契约之上')
  relate('entry_demo_storage', 'entry_demo_processtree', 'related', '两侧同时写文件需要进程级约束')
  relate('entry_demo_workspace', 'entry_demo_host_api', 'depends')
  relate('entry_demo_acl', 'entry_demo_longpath', 'related', 'ACL 修复脚本会遇到长路径')
  relate('entry_demo_cost', 'entry_demo_perf', 'related', '成本评估要参考性能基线')
  relate('entry_demo_dataset', 'entry_demo_prompt', 'related')
  relate('entry_demo_build', 'entry_demo_ci', 'related')
  relate('entry_demo_judge', 'entry_demo_cost', 'related', '分层评估会放大成本')

  // ---------------------------------------------------------------- links

  const addLink = (fromBankId, toBankId, recall = false, query = true) => {
    links[`${fromBankId}->${toBankId}`] = { fromBankId, toBankId, recall, query }
  }
  addLink('bank_demo_spdk', 'bank_demo_dsh', true)
  addLink('bank_demo_spdk', 'bank_demo_win')
  addLink('bank_demo_dsh', 'bank_demo_win')
  addLink('bank_demo_win', 'bank_demo_global', true)
  addLink('bank_demo_eval', 'bank_demo_spdk')
  addLink('bank_demo_legacy', 'bank_demo_global')

  return {
    schemaVersion: 2,
    banks,
    entries,
    links,
    meta: {
      defaultBankByWorkspace: {
        'ws-demo-spdk': 'bank_demo_spdk',
        'ws-demo-dsh': 'bank_demo_dsh',
        'ws-demo-legacy': 'bank_demo_legacy',
      },
      inboxOrder: [],
    },
  }
}
