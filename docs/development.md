# MemStack 开发文档（分片实施）

> 版本：2.0
> 日期：2026-10-21（v1） / 2026-11-03（v2）
> 对应设计：[design.md](./design.md) v2.0；v2 取舍：[roadmap-v2.md](./roadmap-v2.md)
> 原则：**每一片都能独立验证**，任何一片不成立就停下来，不往下叠。

---

## 1. 阅读顺序

设计文档回答"做什么、为什么"；本文回答"怎么落地、按什么顺序、每步怎么验收"。实施时以本文的 Shard 顺序为准，设计文档作为契约来源。

---

## 2. 已确认的环境事实

这些是本次实际勘察的结果，实施时直接采用，不再猜测。

| 事实 | 值 |
|---|---|
| DSH 版本 | 44.7.0（Desktop） |
| 当前 profile | `desktop`，目录 `C:\Users\tachu\.dsh\profiles\desktop` |
| DSH 家目录 | `C:\Users\tachu\.dsh`（`DSH_HOME`） |
| Web GUI | `http://127.0.0.1:61183` |
| CLI | `D:\DSHarness\resources\runtime\cli\bin\dsh.cmd` |
| profile 内容 | 只有 `cordis.yml` / `cordis.patch.yml` / `package.json` / `pnpm-workspace.yaml`，**没有 node_modules** |
| profile bundles | `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`（从安装目录解析） |
| 插件包格式 | `package.json` 声明 `dsh.bundle.patch`；Client 侧声明 `dsh.client` + `./client` 导出 |
| Client 入口格式 | 手写 bundle：`window.__ModuleLoader__.load({ id, factory(require) { ... } })`，**不需要构建步骤** |
| Host 入口格式 | `export function apply(ctx, config) {}`（ESM） |
| 安装方式 | plugin_manager（Web 插件页 / `dsh plugin` CLI）；本地开发用 `link:<绝对路径>` |
| 本会话限制 | 工具集里**没有** `plugin_manager`，安装需走 GUI 插件页或 CLI |

> 注意：Host 插件的代码跑在**承载本会话的同一个进程**里。新装 bundle 在未启用 HMR 时需要重启应用，重启会中断当前会话。所以安装是一个需要用户在场配合的检查点，不是随手可做的动作。

---

## 3. 三个必须先验证的未知点（Spike）

实施前先做，不要等写到一半才发现接口对不上。

| 编号 | 未知 | 验证方式 | 影响 |
|---|---|---|---|
| **SP-1** | `ctx.tools.register()` 是否接受手写的普通对象定义（不经 `defineTool`） | 写一个最小 bundle，注册一个 echo 工具，看会话里能否调用 | 决定是否需要把 `@deepseek-ai/dsh-tools` 引入工作区 |
| **SP-2** | 首次注入如何进入本轮请求：`agent/pre-step` 改写 decision，还是 `agent.inject()` | 注册 `agent/pre-step` 监听，打印 decision 结构；再试 `agent.inject()` | 决定 `inject.js` 的实现形态 |
| **SP-3** | 如何从会话拿到所属工作区 id | 用 `ctx.workspaceRegistry` 按会话 cwd 解析；打印可用方法 | 决定"每工作区一个库"能否自动归属 |

**Spike 的产出不是代码，是结论**：把每条的答案写回本文 §3 下方，再进 S2。

### Spike 结论（2026-10-21，静态勘察 `app.asar` 内的 `lib/index.js`）

| 编号 | 结论 | 证据 |
|---|---|---|
| **SP-1** | **普通对象可以直接注册**，不需要 `defineTool` | `dsh-tools` 的 `register(definition)` 只校验 `output.{schema,render}` 与 `timeoutMs`；`defineTool` 只是把参数 DSL 转成 JSON Schema 再加一层入参校验。手写 `{ name, description, parameters: <JSON Schema>, output: { schema, render }, execute }` 即可 |
| **SP-2** | **走 `agent/pre-step` 改写 decision**，不用 `agent.inject()` | `dsh-agent-instructions` 的范式：`const decision = await next()` → 组一条 user 消息 → `decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired)` → `return { ...decision, messages }` |
| **SP-3** | **`cwd` → `workspaceRegistry.resolveByPath(cwd)`** | `const cwd = await ctx.workingDirectory.ensure(agent, signal)`；`workspaceRegistry.resolveByPath(path)`（不存在的路径会 reject，未被占用的目录返回 `undefined`） |

**另外两条关键事实**：

1. user 消息就是一个普通对象：`createUserMessage(input)` 等价于 `deepFreeze({ ...input, role: 'user', id: randomUUID() })`（来自 `@deepseek-ai/dsh-llm`）。所以可以手写，**不必引依赖**。
2. 会话内查重不要用内存状态：`agent.session.surface.nodes` 里存的是事件序号，用 `agent.session.eventAt(seq)` 取事件，按 `event.data.source.kind === 'memstack'` 找上一次注入的消息（`dsh-agent-instructions` 就是这么做的，因此 resume 后不会重复注入）。

### SP-4（S3 前置）：客户端怎么读写 Host 数据 —— 结论：需要 Typert 代码生成

DSH 自己所有"页面读 Host 数据"的通道都是 Typert：业务 Service 继承 `TypertRemoteService`、方法加 `@Remote`，再由构建期生成 `typert.host.js` 与客户端描述符。实机证据：每个这类包都带一个生成文件，`dsh-client-ui-plugin-manager` 的 92 KB、`dsh-api-session-controller` 的 365 KB。

推论：**手写的纯 JS client bundle 能注册插槽、能渲染，但拿不到 Host 数据**。要走正规通道，需要有 DSH 源码 checkout 并跑它的生成器；本机只有 `app.asar`（打包产物），没有 `src/` 与生成器。

因此 S3 拆成两段：

| 段 | 内容 | 前置 |
|---|---|---|
| **S3a** | 对话内管理：`memory_forget`（停用/删除，删除自动恢复前驱）、`memory_inventory`（全状态、按库分组） | 无，已完成并测试 |
| **S3b** | 可视化界面：**改为独立本地控制台** `console/`，直接读写 SQLite 库；插件激活时自动拉起（`lib/console.js`） | 无，已完成 |
| **S4** | 库与关联：控制台支持建库/改名/描述/私密/停用/删除，以及按源库配置 recall、query 勾选 | 无，已完成 |

**为什么不做进 DSH 页面**：把管理页放进 DSH 才需要 Typert 生成；但记忆数据是本地 SQLite 库，本地控制台（`node console/server.mjs`，监听 127.0.0.1）能读也能改，功能不缩水，还省掉构建链。代价是要多开一个窗口，且需要处理两侧同时写的冲突——v3 起用 SQLite `revision` + `BEGIN IMMEDIATE` 检测（外部改动在下一个工具调用时生效），不再依赖文件 mtime。

### 备选方案（若 SP-1 不成立）

不引入 DSH 包，改为**零依赖**实现：

- 工具：手写定义对象；若注册器要求 `defineTool` 产物，再退回引入包；
- 存储：自管 SQLite 文件（`$DSH_HOME/memstack/memstack.db`），`node:sqlite`，WAL + revision，自带 `schemaVersion`（v1–v2 曾是 JSON 原子写，v3 已替换）；
- 领域事件：自己发，不依赖 `domain/changed`。

代价是放弃 DSH 的 schema 校验与写链；收益是与 DSH 版本解耦、可完全离线单测。**v1 若 SP-1 走不通，就走这条路。**

---

## 4. 仓库结构

```
E:\Code\MemStack\
├── docs/
│   ├── design.md             设计文档（契约）
│   └── development.md        本文
├── package.json              bundle manifest（dsh.bundle.patch）
├── cordis.patch.yml          insert 插件行
├── index.js                  Host 入口：apply(ctx, config)
├── lib/
│   ├── config.js             默认配置与归一化
│   ├── store.js              纯核心：Bank/Entry 状态机、不变量与 dirty 追踪
│   ├── database.js           SQLite 适配：schema、增量提交、revision、迁移、备份
│   ├── render.js             纯函数：索引与通知文本、预算、转义
│   ├── inject.js             pre-step 监听与注入
│   ├── tools.js              工具注册
│   └── export.js             Markdown 导出
├── test/
│   ├── store.test.js
│   └── render.test.js
└── (S3 起) client.js, views/, locale/, icon.svg
```

`lib/store.js` 与 `lib/render.js` **不 import 任何 `@deepseek-ai/*`**，纯 JS + ESM，可用 `node --test` 直接跑。这是整个开发循环的速度来源。

---

## 5. 开发循环（三层，越往下越慢）

| 层 | 做什么 | 命令 | 反馈时间 |
|---|---|---|---|
| L1 纯核心 | store / render / 预算 / 转义 | `node --test test/` | 秒级 |
| L2 集成 | 装 bundle，跑一次会话看工具与注入 | GUI 插件页安装 → 新会话 | 分钟级，需重启 |
| L3 体验 | UI 页面、对话行、撤销 | 刷新页面 | 分钟级 |

**规则**：任何缺陷先在 L1 复现成测试，再改代码。L2 只用来验证"接口接上了"，不用来调逻辑。

---

## 6. Shard 计划

| Shard | 目标 | 产出 | 验收 |
|---|---|---|---|
| **S0** | 环境与接口勘察 | 本文 §2、§3 结论 | spike 三问有答案 |
| **S1** | 纯核心 | `store.js`、`render.js`、`config.js` + 单测 | `node --test` 全绿；覆盖 6 条不变量 |
| **S2** | 最小闭环（M1） | `index.js`、存储层（v3 为 `database.js`）、`tools.js`、`inject.js` | 新会话能读到旧决策，且不再建议被否方案 |
| **S3** | 可见与可管（M2/M3） | 设置页、对话行、`/remember` | 能查、能改、能删；写入可见可撤销 |
| **S4** | 关联与候选（M4） | 关联矩阵、可发现性、`/wrap`、Inbox | 未注入的库能搜到；候选不注入 |
| **S5** | 治理（M5） | 整理器、导出、迁移脚本 | 长期使用条目数不失控 |

依赖关系：S1 不依赖任何 spike；S2 依赖 SP-1/SP-2/SP-3；S3 依赖 S2 的数据可用；S4/S5 相互独立。

**当前进度（2026-10-21）**：S1、S2 代码完成并已安装；注入链路在本机现场验证通过（工具上线、索引注入、状态落盘）。剩余：跨会话行为验收、S3。

---

## 7. 各 Shard 的实施细节

### S1 · 纯核心

**目标**：把"记忆该怎么变"全部实现成不依赖 DSH 的纯函数，用测试锁死行为。

产出接口：

```js
// store.js
new Store(state?, { now, id })
store.writeEntry({ bankId, topic, kind, claim, detail, rejected, confidence, pin, source })
  // → { result: 'created' | 'superseded' | 'duplicate', entry, previous? }
store.archiveEntry(id) / restoreEntry(id) / deleteEntry(id)
store.createBank({ kind, title, description, workspaceIds })
store.ensureWorkspaceBank(workspaceId, title)     // 惰性创建
store.archiveBank(id) / restoreBank(id) / deleteBank(id)
store.link(fromBankId, toBankId, { recall, query }) / unlink(...)
store.listBanks() / listEntries(bankId, { status, kind, q })
store.takeChanges()                                // 供注入层消费

// render.js
renderIndex(state, { bankIds, maxBytes, topK, discoverabilityBudget })
renderChange(change)
wrapReminder(body)
escapeMemoryText(text)
```

**测试清单（必须全绿）**：

| # | 用例 | 断言 |
|---|---|---|
| T1 | 同 topic 写两次 | 第二次 `superseded`，旧条目 `status=superseded` 且 `supersededBy` 指向新条目 |
| T2 | 同 topic 同 claim 再写 | `duplicate`，库内条目数不变 |
| T3 | 删除取代者 | 前驱恢复为 `active`，且 `supersededBy` 清空 |
| T4 | 预算截断 | 渲染字节 ≤ maxBytes，且文本含"省略 M 条" |
| T5 | 转义 | 内容含 `</system-reminder>` 时，渲染结果不出现可闭合标签 |
| T6 | 私密库/停用库 | 不出现在索引与可检索库列表中 |
| T7 | 可检索库行 | 预算 512 字节内，最多 8 个，超出写"等 N 个" |
| T8 | 不变量扫描 | 任意随机操作序列后，同库同 topic active 唯一、链无环 |

**完成标准**：`node --test` 全绿，代码中无 `@deepseek-ai/*` import。

**S1 完成记录（2026-10-21）**

- 产出：`lib/store.js`（状态机）、`lib/render.js`（索引/通知/预算/转义）、`lib/config.js`、`index.js` 占位、`cordis.patch.yml`、`package.json`。
- 测试：`test/store.spec.js`、`test/render.spec.js`，工具函数在 `test-support/helpers.js`（放在 `test/` 外，避免被测试运行器当成用例文件）。
- 结果：15 项全绿，`duration_ms` < 150。
- **实现时发现的规则**：删除链中间的条目不能只删——否则前驱的 `supersededBy` 与后继的 `supersedes` 都会悬空。正确做法是把前驱与后继直接接线（已写入 design.md I6，并有用例 T3c 锁定）。
- 误差记录：`node --test test/` 在 Node 24 下会把目录当模块解析，脚本改为 `node --test`（自动发现）。

### S2 · 最小闭环（M1）

步骤：

1. **spike**（SP-1/2/3），把结论写回 §3；
2. `database.js`：SQLite schema、加载/增量提交与旧 JSON 迁移（v1–v2 曾是 `persist.js` 的 JSON 原子写，v3 已删除该模块）；
3. `index.js`：`apply(ctx, config)` 里按顺序初始化 store → 注册工具 → 注册注入监听；
4. `tools.js`：`memory_write` / `memory_search`（`memory_read` 可延后）；
5. `inject.js`：首轮组索引、变更追加通知；
6. 装 bundle，跑验收场景。

**验收（必须逐条过）**：

- [ ] 新会话中对项目提问，模型能引用已记录的决策；
- [ ] 记录"pre_load 已否决"后，新会话问接入方式，**不再建议 pre_load**；
- [ ] 同一 topic 二次写入，会话里出现"更新 + 已失效"通知；
- [ ] 删除条目后，新会话不再出现该结论；
- [ ] 注入文本 ≤ 预算，省略时有明确计数。

**S2 完成记录（2026-10-21，代码完成，未安装）**

- 产出：`lib/database.js`（SQLite 增量提交 + 单写事务；v1–v2 为 `persist.js` 原子写 + 单写链）、`lib/sync.js`（快照/差分/驳回通知）、`lib/query.js`（检索与读取）、`lib/tools.js`（三个工具）、`lib/inject.js`（pre-step 注入）、`index.js`（装配）。
- 单测：29 项全绿，其中 `test/plugin.spec.js` 用假 ctx 跑通了完整注入链路（空库不注入 → 首次注入索引 → 无变化不重复 → 推翻结论注入驳回 → 删除注入废止）。
- **两个真问题**：
  1. 差分最初以条目 id 为键，导致"取代"被渲染成"新增 + 废止"，驳回记录丢失。改为 `(bankId, topic)` 为键（已写进 design.md §8.4）。
  2. `ready()` 被当成布尔门（`if (!ready) return`），导致注入静默失效；`ready` 是加载门，不是状态位。已改为只在返回 `false` 时跳过，并加了用例。

**安装验证记录（2026-10-21，实机）**

- 命令：`dsh plugin --profile desktop add "link:E:\Code\MemStack"`，550ms 完成。
- **CLI 的行为比文档写的多**：它不只在 `dependencies` 写 `link:`，还自动把 `@local/memstack` 追加进 `dsh.profile.bundles`，随后桌面端热重组，**无需重启**。文档 §8 已按实测修正。
- 现场证据：三个工具当场出现在工具集；本轮上下文里出现 `<system-reminder>` 索引；`$DSH_HOME/memstack/state.json` 落盘（v3 起为 `memstack.db`）；`workspaceRegistry.resolveByPath` 解析出真实工作区 id，库标题自动取为 `MemStack`。
- 显示注意：PowerShell 直接 `Get-Content` 该 JSON 会显示乱码，那是控制台按 GBK 解码 UTF-8 的显示问题；用 Node 以 `utf8` 读回校验正常。
- **M1 首轮验收的方法错误**：验收脚本引用的是 design.md 附录 B 的示例数据，而那条 SPDK 结论从未真正写入库，于是新会话只看到两条插件自身的记忆，检索当然为空。结论：**链路验证 ≠ 行为验证**；今后每次验收先写入真实条目，再开新会话观察，不能拿文档示例当数据。

### S3 · 可见与可管

1. 设置页（`settings.section`）：库列表 + 条目表 + 编辑/停用/删除；
2. 对话行（`conversation.chat.node`）：写入记录 + 撤销；
3. `/remember` 命令；
4. 安装后刷新页面验证（客户端改动不需要重启 Host）。

### S4 · 关联与候选

关联矩阵弹窗、可发现性行、`/wrap` + Inbox。

### S5 · 治理

整理器（合并近似 / stale / TTL）、Markdown 导出、迁移脚本。

---

## 8. 安装、卸载与迭代

**安装（CLI，实测可行）**

```powershell
& 'D:\DSHarness\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add "link:E:\Code\MemStack"
```

实测：该命令不只写 `dependencies`，还会把包名追加进 profile 的 `dsh.profile.bundles`，随后热重组生效——**不需要重启，也不用手工改 profile**。安装前建议备份 `~/.dsh/profiles/desktop/package.json`。

> 本机这套 Desktop 构建的设置页里没有出现「安装第三方插件」入口（只有内置插件列表），所以 GUI 路径不可用；CLI 是有效路径。

**卸载**：GUI 插件页移除；或 `dsh plugin --profile desktop remove @local/memstack`。

**迭代**：
- Host 代码改动 → 需重启（或确认 profile 启用了 HMR）；
- Client 代码改动 → 刷新页面即可（需 `dsh-client-hmr`）；
- 数据目录不会因卸载而删除，重装后仍在。

---

## 9. 调试手段

| 需求 | 方法 |
|---|---|
| 看合成后的 profile | `dsh --profile desktop --dump-config` |
| 看插件是否加载 | GUI 插件页状态；启动日志里找 `memstack` |
| 看注入内容 | 会话里检查用户消息是否含 `<system-reminder>`；或临时在 `inject.js` 打印 decision |
| 看持久化数据 | `$DSH_HOME/memstack/memstack.db`；用 `node --input-type=module -e "..."` 或任意 SQLite 客户端查表（注意 WAL） |
| 复现逻辑缺陷 | 先写 `test/*.test.js`，再改代码 |

日志不要 `console.log` 到用户可见输出；用 `ctx.logger` 或临时文件。

---

## 10. 编码约定

1. ESM，`type: "module"`，不用 TS 构建（Client 是手写 bundle，Host 是纯 JS）。
2. `lib/store.js`、`lib/render.js` 零依赖；时间与 id 通过构造参数注入，便于测试。
3. 所有写操作经过 store 方法，不直接改 state 对象。
4. 内存中的 state 保持纯 JSON（无函数、无 Date 对象），便于 bundle 导出与测试；落盘由 SQLite 负责，不再全量 `JSON.stringify`。
5. 用户可见文案走 locale 文件（S3 起）；Host 内部错误信息用英文常量，方便检索。
6. 不吞错误：持久化/提交冲突要抛，让上层决定是否重试或降级。

---

## 11. 风险登记

| 风险 | 触发条件 | 应对 |
|---|---|---|
| SP-1 不成立 | 普通对象无法注册为工具 | 走 §3 备选方案（引入包或零依赖） |
| 安装需重启打断会话 | 未启用 HMR | 把安装放在检查点，提前告知用户 |
| 注入决策结构不熟 | SP-2 失败 | 退化为 `agent.inject()`，接受一轮延迟 |
| 工作区归属拿不到 | SP-3 失败 | 用 cwd 作为 bank 键（目录即身份），后续再迁移 |
| 与 AGENTS.md 内容重复 | 两者都写了同一规则 | 文档与注入文案明确职责边界；UI 提示 |

---

## 12. v2 实施记录

v2 不再按“先 spike 再写”推进，而是每个模块先落纯函数与测试，再接 UI/HTTP：

| Shard | 内容 | 验收 |
|---|---|---|
| V1 | `lib/decay.js` + store 迁移 | 固定时钟下留存率、复习/召回、锚点、不变量 |
| V2 | schema v2 字段与 `assertInvariants` | v1 state 幂等迁移；随机操作序列后不变量成立 |
| V3 | 注入排序与 `reinforce` | dormant 不注入但可检索；每轮只加固一次 |
| V4 | `lib/graph.js` | 节点/边去重、派生边上限、inactive 过滤、summary |
| V5 | `lib/portable.js` + CLI | merge 幂等、id 重映射、topic 冲突归档、legacy 解析、Markdown |
| V6 | 控制台 API | 真实 HTTP 集成测试覆盖 UTF-8 写读、复习、关系、导出/导入、备份 |
| V7 | 3D 图谱与四个页面 | 截图检查深/浅色、抽屉 inset、筛选、空状态 |

### 12.1 测试

```powershell
$node = 'C:\Users\<you>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node --test        # 91 项，当前全绿
```

- 纯逻辑测试全部显式传 `now`，不要依赖 `new Date()`；
- `test/server.spec.js` 会起真实 `server.mjs`（临时 `MEMSTACK_HOME` + 随机端口），务必在 `t.after` 里 `child.kill()` 并清理临时目录，否则 `node --test` 会挂住；
- 插件测试使用 `{ consoleEnabled: false }`，避免测试进程拉起真实控制台。

### 12.2 踩过的坑

| 现象 | 原因 | 修复 |
|---|---|---|
| `node --test` 超过 120s 不退出 | 插件默认启动控制台，子进程未 unref | 测试禁用 console + `child.unref()` |
| 所有条目都显示“沉寂” | 测试夹具用真实 `new Date()`（2026-11） | 固定 `NOW` 传入 |
| 中文/编码被破坏 | PowerShell `Set-Content` 重写 UTF-8 文件 | 只用 write/edit 工具改文本 |
| 空面板/空状态盖住图谱 | `.drawer` / `.graph-empty` 的 display 覆盖了 `[hidden]` | 全局 `[hidden]{display:none!important}` |
| 导入后条目翻倍 | PowerShell `Invoke-RestMethod` 把中文发成 `?`，导致内容比较失败 | 浏览器 UTF-8 fetch 正常；集成测试用 fetch |
| 浅色截图文字仍是深色主题 | 主题在首帧后才由 JS 设置，CSS 颜色 transition 停在起点 | `<head>` 内联脚本在样式表前恢复主题 |
| 深链打开抽屉时节点藏在抽屉后 | `openHashEntry` 在 `setData` 之前调用，`focus` 无位置 | boot 中 `await refreshGraph()`；先 `syncDrawerInset()` 再 focus |
| 图谱右侧节点被裁 | 默认相机距离固定 900，36 节点放不下 | 按节点数 780/940/1080/1220 自适应 |

### 12.3 零依赖边界

- 控制台不引 three.js / d3 / 打包器：3D 投影、力导向、sprite、标签避让都在 `console/graph3d.js`；
- bundle 不依赖 DSH 内部包：只用 Node 标准库与 `index.js` 的 Host 契约；
- 不把 `node_modules` 或构建产物提交进仓库；`npm test` 在裸 Node 下可跑。

---

## 13. v3：SQLite 持久化

### 13.1 改动范围

| 文件 | 变化 |
|---|---|
| `lib/database.js` | 新增。`node:sqlite` schema、`loadStore`/`commitStore`、`StoreDatabase`、迁移、备份 |
| `lib/store.js` | 新增 `dirty` 集合与 `mark*`/`clearDirty`；每个领域操作标记被改动的实体 |
| `index.js` | 启动时打开数据库；`refresh()` 比较 `revision`；`commit()` 带 `expectedRevision` 提交 |
| `console/server.mjs` | 长连接 `StoreDatabase`；请求读缓存快照；写操作放进事务；导入前在线备份 |
| `console/cli.mjs` | export/import 直接读写数据库；import 前备份 `.db.<stamp>.bak` |
| `console/demo.mjs` | 每次演示前重建 SQLite 并直接播种，不再写 `state.json` |
| `lib/persist.js` | 删除；JSON 只作为 bundle / 迁移格式存在 |
| `test/database.spec.js` | 新增往返、增量、级联删除、revision 冲突、迁移、损坏 JSON、备份、缓存事务测试 |

### 13.2 提交路径

```text
工具/控制台 handler
  └─ Store 方法（改 state，标记 dirty，记录 changes）
      └─ commitStore(db, store, { expectedRevision })
          ├─ BEGIN IMMEDIATE
          ├─ SELECT revision，与 expectedRevision 比对（不一致 rollback + state-conflict）
          ├─ upsert dirty rows / delete missing rows
          ├─ revision + 1
          └─ COMMIT（成功后 clearDirty）
```

控制台的 `StoreDatabase.mutate()` 把 handler 放进同一个事务；Host 仍是“工具执行完再提交”，所以极端并发下可能收到冲突，下一次工具调用会在 `prepare()` 里重新加载后重试。

### 13.3 迁移与回滚

- 首次启动迁移：解析旧 JSON → `Store.fromJSON()` → 全量写库 → 旧文件改名 `.migrated-*.bak`。
- 解析/写入失败：关闭并删除刚创建的空库文件，旧 JSON 不动；错误前缀 `legacy-migration-failed:`。
- 需要回滚到 v2：停掉 Host/控制台，删除 `memstack.db`（及 `-wal`/`-shm`），把 `state.json.migrated-*.bak` 改回 `state.json`，再安装 v2 代码。注意：v2 代码不认识 v3 期间新增的数据。

### 13.4 调试

```powershell
$node = 'C:\Users\<you>\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node --input-type=module -e "import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(process.env.DSH_HOME + '/memstack/memstack.db'); console.log(db.prepare('select key,value from meta').all()); console.log(db.prepare('select status,count(*) n from entries group by status').all()); db.close()"
```

- 不要用 PowerShell 的 `Get-Content`/`ConvertFrom-Json` 检查中文内容，控制台代码页会误伤；用 Node 以 `utf8` 读取。
- WAL 模式下主文件可能落后于 `-wal`；排查时连同 `-wal` 一起看，或直接查数据库连接。
- `node:sqlite` 是同步 API，不要在事务里 `await`；控制台 handler 保持同步。

### 13.5 测试注意

- 每个数据库测试用独立临时 home，结束时先 `db.close()` 再 `rm`；Windows 上打开的文件不能删。
- 并发测试开两个 `DatabaseSync` 连接，模拟 Host + 控制台；断言失败提交不会写入。
- 服务端集成测试要等子进程退出后再清理临时目录。

---

## 14. 安全约定：破坏性操作

### 14.1 2026-11-03 事故

一次"验证 v3 迁移 + 清理测试 home"的一次性长命令，以
`Remove-Item -LiteralPath $home -Recurse -Force` 结尾。`$home` 是 PowerShell
的**只读自动变量**，恒等于 `%USERPROFILE%`（`C:\Users\admin`），对它赋值只会
报错并被忽略。结果整个用户目录被递归删除：

| 被删 | 后果 |
|---|---|
| `~/.dsh`（profile、sessions、memstack 数据） | DSH 自身状态与会话上下文 |
| `~/.config/opencode`、`~/.local/share/opencode` | opencode 的 API 配置与会话库 |
| `AppData/Local/Programs/DeepSeek Harness`、`.../ai.opencode.desktop` | 两个应用的安装目录 |

只有被进程占用的文件幸免（输出里满屏"正由另一进程使用"），`D:\dsh-memstack`
因为不在 `C:\Users\admin` 下而完好——**事故与插件放置的目录无关**。

**证据**（唯一存活的现场）：`%TEMP%\dsh-spill-1ZYusS\session-5e45483e4446\*-pwsh.txt`，
726 行里 700+ 行是 `无法删除项 C:\Users\admin\...`，命令行片段为
`+ ... | Format-List; Remove-Item -LiteralPath $home -Recurse -Force; Remove ...`，
位置"行:1 字符: 1103"。

**早于删除一分钟的信号**：`C:\Users\admin\memstack\state.json`（11:35:24）其实是
一个 memstack SQLite 库——说明那个"测试 home"在删除前已经指向真实用户目录，
没有人核对解析结果。

### 14.2 护栏

| 文件 | 作用 |
|---|---|
| `scripts/guard.mjs` | 删除前断言：目标必须 realpath 后位于临时根内、不等于临时根、不是受保护目录（用户目录、`~/.dsh`、`~/.config`、`~/.local`、`APPDATA`、`LOCALAPPDATA`）或仓库的祖先；临时根自身被污染（`TMP` 指向用户目录）时整体拒绝 |
| `scripts/home.mjs` | 唯一入口：`new` / `check` / `reset` / `backup` |
| `test/guard.spec.js` | 11 项回归测试，其中"拒绝删除用户目录"直接锁定本次事故形态 |

```powershell
$node = 'C:\Users\admin\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'

$testHome = & $node scripts/home.mjs new      # 只打印路径
& $node scripts/home.mjs check $testHome      # 打印解析后的真实路径，不删任何东西
& $node scripts/home.mjs reset $testHome      # 断言通过才递归删除
& $node scripts/home.mjs backup               # 备份到 D:\dsh-backups\<stamp>（异卷）
```

- `reset` 没有默认目标：空路径直接拒绝，`$env:TEMP` 之外的路径一律拒绝。
- `check` 可用于任何路径：对 `C:\Users\admin` 会返回 `[protected]`，`exit 1`。
- junction/symlink 按 realpath 判定，不会因为名字像临时目录就放行。
- `backup` 只复制、从不删除；默认源是 `$DSH_HOME` 与 `~/.config/opencode`。
  `--with-opencode-data` 才会带上 `opencode.db`（WAL 库，运行中复制可能不一致）。

### 14.3 操作纪律

1. 不用 `$home`、`$HOME`、`$profile`、`$env`、`$input` 作变量名；临时目录叫 `$testHome`。
2. 一条命令只做一件事。禁止把"导出 + 检查 + 删除"串成一条 1000+ 字符的命令——审批框里看不出变量真实取值。
3. 删除前必须 `check`，并在输出里确认解析后的绝对路径。
4. 改 profile、`~/.dsh`、`AppData` 前先 `backup`；备份放异卷，避免与源一起被删。
5. `DSH_HOME` 必须是专用目录，禁止设成 `%USERPROFILE%` 本身；否则 `~/memstack/` 会污染用户目录根部，任一"清理 home"的脚本都可能把整棵 profile 当目标。
6. 需要清理时只清理 `$env:TEMP` 下自己的子目录，不碰用户目录里的任何东西。

