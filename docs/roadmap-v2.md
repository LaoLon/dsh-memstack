# MemStack v2 路线图：遗忘曲线 · 图谱 · 3D 控制台 · 跨机迁移

> 版本：2.0（已实施）
> 日期：2026-11-03
> 状态：V1–V7 已完成；后续 v3 已把本地真源从 `state.json` 换成 SQLite，当前 91 项测试全绿。实施记录见 [development.md §12](./development.md) 与 [§13](./development.md)
> 前置：[design.md](./design.md) v2.0、[development.md](./development.md)
> 本文只记录 v2 的增量决策；v1 的契约（topic 唯一 active、supersede 链、rejected[]、注入只追加）不变。

---

## 1. 目标与边界

v1 解决的是"旧结论反复出现"。v2 要解决的是**记忆随时间与规模增长后的三个新问题**：

| 问题 | v2 的答案 |
|---|---|
| 记忆只增不减，一年后库里全是"还成立吗" | **遗忘曲线**：每条记忆有稳定度与留存率，按复习/召回强化，注入按留存加权，沉寂条目降权但不静默删除 |
| 条目之间只有 topic 取代关系，看不到"这件事牵动了什么" | **图谱**：显式关系（refines / depends / contradicts / related）+ 派生的主题同族、共享标签、同库归属，形成可探索的网络 |
| 记忆藏在 `state.json` 里，换机器只能整个目录拷 | **可迁移**：带版本的 JSON bundle + Markdown 投影；导入支持合并/替换、ID 重映射、冲突报告（v3 起本地真源为 SQLite，bundle 格式不变） |

**不做**（仍然是 v2 的非目标）：向量检索、后台自动整理、团队共享、云端同步、自动删除记忆。

三条不可动摇的原则，v2 继续遵守：

1. **记忆是状态，不是日志。** 衰减只改变"多容易被想起"，不篡改结论。
2. **任何自动行为都必须可见。** 衰减在 UI 里显示为留存率与阶段；不会静默删条目；导入合并有报告。
3. **写入仍然经过 `lib/store.js`。** 新字段、新边都走 mutation，不在旁路改 state。

---

## 2. 遗忘曲线（Forgetting Curve）

### 2.1 模型

采用 Ebbinghaus 指数衰减的离散化形式，稳定度 `S` 以**天**为单位，含义是"留存率降到 50% 所需的时间"：

```
R(t) = 0.5 ^ (ageDays / S)
ageDays = (now - (lastReviewedAt ?? createdAt)) / 86400000
```

- `R ∈ (0, 1]`，`R = 1` 表示刚复习过。
- 使用 `lastReviewedAt` 而不是 `updatedAt`：编辑 claim 不等于你想起了它。
- 只读计算，无定时器、无后台任务；每次读取时按 `now` 求值，天然跨进程一致。

### 2.2 初始稳定度

`S0 = KIND_STABILITY[kind] × CONFIDENCE_FACTOR[confidence]`，再乘以停留时间（`pinned` ×4）。

| kind | S0（天） | 理由 |
|---|---|---|
| `constraint` | 90 | 版本/协议限制变化最慢 |
| `gotcha` | 90 | 踩过的坑最难忘 |
| `decision` | 60 | 决策会随项目演进被取代 |
| `preference` | 120 | 用户偏好最稳定 |
| `open-question` | 14 | 未决问题应尽快被回答或丢弃 |

`confidence: tentative` 的因子是 `0.35`（"未验证"就该更快被重新审视）。上限 730 天。

### 2.3 强化

| 触发 | 效果 | 说明 |
|---|---|---|
| 复习（用户确认仍成立） | `S ← min(730, S × 1.8)`，`lastReviewedAt = now`，`reviewCount++` | 间隔重复的"成功回忆" |
| 被注入/被检索命中 | `S ← min(730, S × (1 + 0.25 × (1 - R)))`，`lastRecalledAt = now`，`recalledCount++` | 困难时想起收益更大（spacing effect） |
| 同 topic 写入新结论 | 新条目 `S0`，旧条目留存率冻结在 supersede 时刻 | 取代不是遗忘 |

**注入即强化必须只写一次。** 首次索引注入时对入选条目做一次召回标记并 commit；变更通知不强化，避免每轮写盘。

### 2.4 阶段与注入策略

| 阶段 | 留存率 | 注入 |
|---|---|---|
| `fresh` 新鲜 | R ≥ 0.8 | 正常，排序靠前 |
| `stable` 稳定 | 0.5 ≤ R < 0.8 | 正常 |
| `fading` 淡化 | 0.2 ≤ R < 0.5 | 正常但降权 |
| `dormant` 沉寂 | R < 0.2 | **不进索引正文**，只在汇总行说明"有 N 条长期未复习，可用 memory_search 检索" |

- `pinned` 永远注入，不被 dormant 规则排除。
- 排序：`pinned` → `dormant?` → `importance × R^0.7` → `updatedAt`。`importance` 由 kind 决定（constraint/gotcha 更高）。
- 检索（`memory_search`）**不因 dormant 隐藏**，但结果里带 `retention`/`stage`，模型能判断"这条记忆可能不可靠"。
- 不自动删除。治理只提供"待复习"清单与批量停用（需确认）。

### 2.5 数据字段（Entry 增量）

```ts
stabilityDays: number      // 稳定度，天；缺省按 kind/confidence 推导
lastReviewedAt?: string    // 上次确认仍成立
lastRecalledAt?: string    // 上次被注入/检索
recalledCount: number      // v1 已有，沿用
reviewCount: number
```

`createdAt` 永远是"结论诞生时间"；`lastReviewedAt` 缺省时视为 `createdAt`。

---

## 3. 图谱（Graph）

### 3.1 节点

| 类型 | 来源 | 说明 |
|---|---|---|
| `bank` | Bank | 聚类中心，半径随条目数增长 |
| `entry` | Entry | 记忆条目；颜色按 kind，透明度按 status |

### 3.2 边

| type | 来源 | 语义 | 默认显示 |
|---|---|---|---|
| `contains` | bankId | 库包含条目 | 是（细、低透明度） |
| `supersede` | supersedes | 新结论取代旧结论 | 是（有向、暖色） |
| `relation` | entry.relations[] | 人工/模型显式关系 | 是（按子类型着色） |
| `topic` | topic 前缀（首段相同） | 同族主题 | 是（虚线、弱） |
| `tag` | 共享标签 | 同标签 | 否（可开，弱） |
| `bank-link` | Link | 库之间注入/检索关系 | 是（粗、双色） |

- `relation.type ∈ { related, refines, depends, contradicts }`，存储在**源条目**上，`target` 为目标条目 id；删除条目时同步清理指向它的关系（不变量 I7）。
- 派生边有上限：同族/同标签每节点最多连 3 条，按更新时间和留存率取最近的，避免"中心节点爆炸"。
- 图谱是**读取投影**，不新增真源数据（除显式 relations）。

### 3.3 不变量（新增）

| 编号 | 不变量 |
|---|---|
| I7 | `relations[].target` 必须指向同库或可见库中的现存条目；删除条目时清理入边 |
| I8 | `stabilityDays ∈ [0.5, 730]`；`lastReviewedAt` 不晚于 `now`（写入时取 `now`） |

---

## 4. 跨机器迁移（Portable Bundle）

### 4.1 文件格式

```json
{
  "format": "memstack.bundle",
  "version": 2,
  "exportedAt": "2026-11-03T02:00:00.000Z",
  "app": { "name": "@local/memstack", "version": "0.3.0" },
  "source": { "machine": "hostname", "platform": "win32", "dshHome": "C:/Users/me/.dsh" },
  "stats": { "banks": 3, "entries": 42, "links": 2 },
  "state": { "schemaVersion": 2, "banks": {}, "entries": {}, "links": {}, "meta": {} }
}
```

- 全量导出（含 superseded / archived 历史），因为"驳回记录"是记忆价值的一部分。
- 不导出机器绝对路径以外的运行时字段；`source` 只用于展示来源。
- Markdown 投影按库导出，供 git diff / 人读；**导入只接受 JSON bundle**，避免格式歧义。

### 4.2 合并规则

| 情况 | 处理 |
|---|---|
| 库 id 已存在且内容一致 | 复用 |
| 库 id 冲突但 (kind,title) 匹配 | 映射到本地库 id |
| 库不存在 | 新建（保留 id，冲突则换新 id） |
| 条目 id 不存在 | 直接加入 |
| 条目 id 已存在且内容一致 | 跳过（计入 duplicate） |
| 条目 id 已存在但内容不同 | 分配新 id，记录冲突 |
| 同库同 topic 已有 active 且 claim 相同 | 跳过（重复记忆） |
| supersede / relation 指向重映射的 id | 同步改写引用 |

导入结果返回报告：`{ banksAdded, banksMapped, entriesAdded, entriesSkipped, entriesRemapped, linksAdded, conflicts[] }`。**默认 `mode: merge`**；`replace` 需要显式选择（UI 二次确认）。

### 4.3 命令行

```powershell
npm run export -- -o memstack.bundle.json          # 导出全量
npm run import -- memstack.bundle.json --mode merge # 导入
```

CLI 是 `console/cli.mjs`，与 UI 共用 `lib/portable.js`，不依赖网络。

---

## 5. 控制台 v2（3D 图谱 UI）

### 5.1 技术约束

- **零依赖、零构建**：单页 + 原生 ESM；3D 由自写的 Canvas2D 投影力导向渲染器完成，不引 three.js，不依赖 CDN（控制台必须离线可用）。
- 数据通道仍是本地 HTTP：`/api/state`、`/api/graph`、`/api/export`、`/api/import`。
- 深浅主题跟随系统并可手动切换，中英文切换；数据不因语言变化。

### 5.2 信息架构

左侧导航 + 四个视图：

| 视图 | 内容 |
|---|---|
| **图谱** | 全屏 3D 网络；顶部筛选（库/kind/状态/边类型）、自动旋转、2D 切换、重置视角；右侧详情抽屉 |
| **记忆** | 检索 + 筛选 + 排序（留存率/更新时间）；每行显示留存率条与阶段；抽屉内复习、编辑、停用、删除、关系 |
| **记忆库** | 库卡片（条目数、平均留存、描述）、新建、关联矩阵 |
| **数据** | 导出 JSON/Markdown、导入（拖拽/选择 + 合并策略 + 报告）、统计、待复习清单 |

### 5.3 渲染器要点

- 布局：3D 力导向（库节点环上锚定 + 条目弹簧 + 斥力 + 向心），初始球面分布，冷却后冻结；数据变化再加热。
- 相机：轨道（拖拽旋转、滚轮缩放、触屏单指旋转/双指缩放），自动旋转可选。
- 视觉：径向渐变节点、深度衰减、邻接高亮、悬停 tooltip、选中聚焦、库标签常显、条目标签悬停显示。
- 性能目标：≤ 400 节点 / ≤ 1500 边，60fps；节点贴图预渲染，边按透明度批量绘制。

---

## 6. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| **V2-A 核心** | decay / graph / portable 三个纯模块 + 单测 | `node --test` 全绿；不变量含 I7/I8 |
| **V2-B 接入** | store 迁移、注入排序与强化、工具扩展、控制台 API | 新库注入按留存排序；dormant 不进正文；导入报告正确 |
| **V2-C 界面** | 3D 图谱 + 记忆/库/数据视图 | 可旋转缩放、点选查看、筛选生效；深浅色与中英文正常 |
| **V2-D 验证** | 截图、真实数据演练、文档 | 控制台截图；跨机导入演练；README/设计文档更新 |

---

## 7. 决策记录（v2）

| # | 决策 | 选择 | 理由 | 代价 |
|---|---|---|---|---|
| 7 | 3D 实现 | 自写 Canvas2D 投影，不引 three.js | 离线可用、零构建、体积可控 | 视觉效果比 WebGL 弱一档，需要自己写力导向 |
| 8 | 衰减是否删条目 | 不删，只降权并展示 | 删除会让模型重新推导旧结论；且用户失去审计线索 | 库会变大，需要复习视图 |
| 9 | 召回即强化 | 只对注入入选条目强化一次 | 让"常用记忆"自然变牢，符合间隔重复 | 与真实"想起"有偏差，但可解释 |
| 10 | 图谱边来源 | 显式 relations + 派生主题/标签边 | 兼顾可控与自动发现 | 派生边可能有噪音，需要开关 |
| 11 | 导入冲突 | 默认保留双方，冲突条目换新 id | 跨机合并不能静默丢结论 | 会出现同 topic 两条 active（不同 bank 下合法；同库同 topic 由 claim 相同判定跳过） |
| 12 | 导入是否进注入 | 合并后按库归属自然生效，不额外注入历史 | 避免一次导入把上下文塞爆 | 用户需要自己开新会话确认 |

> 注：决策 11 中"同库同 topic 两条 active"违反 I1，因此导入时若 claim 不同，**保留本地 active，把导入条目降为 `superseded` 是不可能的**（会伪造取代链）。正确做法见 §4.2：冲突时改写 id 并**保持原状态**，但若目标库已有同 topic active，则导入条目改为 `archived` 并记录冲突原因 `topic-taken`，由用户在 UI 里选择是否停用本地条目。该规则由测试锁定。

---

## 8. 风险

| 风险 | 应对 |
|---|---|
| 衰减参数主观 | 全部集中在 `lib/decay.js` 的常量表 + `config.js` 覆盖，UI 显示当前参数 |
| 3D 在小数据量下不好看 | 空态设计；≤5 节点时自动居中放大；提供 2D 模式 |
| 导入把本地库改坏 | 默认 merge；replace 二次确认；导入前自动备份 `memstack.db.<stamp>.bak` |
| 新字段使旧版本打不开 | schemaVersion 2 + `Store.fromJSON` 幂等补默认值；README 注明降级方法 |
| 测试再次被控制台子进程挂住 | 测试配置 `consoleEnabled: false`，并在 supervisor 里 `unref()` 子进程 |
