# MemStack

> 给 [DeepSeek Harness](https://github.com/deepseek-ai) 的**可治理长期记忆**：记录项目里仍然成立的判断，而不是对话摘要；会随时间遗忘、能被新结论取代、可以在图谱里看见，也能整库搬到另一台机器。

旧结论被新结论**取代**，被否掉的方案连同原因一起留着；每条记忆都有留存率，衰减只影响“是否被注入”，不会删除结论。这是它和“云端记忆”最大的区别。

![记忆图谱](docs/assets/graph.png)

## 为什么不是“对话摘要”

云端记忆的典型故障：你试过方案 A 发现不行，改用方案 B，但记忆里 A 还在，模型之后反复建议 A，而你没法定点删除。

根因有四条：自动写入无门槛、只有追加没有覆盖、全局共享、不可见不可删。MemStack 的对策：

| 问题 | 做法 |
|---|---|
| 新旧结论并存 | 同一 `topic` 只允许一条生效；写新结论时旧的自动变 `superseded`，保留完整历史 |
| 模型反复推荐旧方案 | 旧条目保留 `rejected[]`（被否决的选项 + 原因），注入时明确标注“已失效，不要再建议” |
| 全局污染 | 记忆按工作区隔离；跨库默认只可检索，不默认注入 |
| 看不见、改不动 | 本地控制台：图谱、列表、库、数据迁移、检索、编辑、停用、删除 |

## 四个能力

- **跨会话记忆**：Host 插件在会话首次请求注入索引；条目带来源会话，变更以可追溯的 `system-reminder` 追加。
- **遗忘曲线**：Ebbinghaus 指数衰减 + 间隔重复。检索结果带留存率；确认“仍然成立”会重置曲线，标记“过时”则停用。
- **关系图谱**：手写 Canvas 2D 的 3D 力导向图，不需要 three.js、CDN 或构建步骤；支持旋转、缩放、聚焦、筛选、2D/3D 切换。
- **可迁移**：JSON bundle 含全部历史（含已取代条目）；控制台拖拽导入，或 CLI 导出/导入；导入前自动备份当前 SQLite 库。

## 核心模型

| 概念 | 说明 |
|---|---|
| **Bank（记忆库）** | 一组记忆的容器。每个工作区一个 `workspace` 库，另有跨项目的 `topic` 库与单例 `global` 库 |
| **Entry（条目）** | 一条判断：`topic` + `claim`（一句话结论）+ `detail` + `rejected[]` + `tags[]` + `relations[]` |
| **Topic（主题键）** | 稳定标识，如 `spdk.ingest-path`。同一 bank + topic 只有一条 `active` |
| **状态** | `active` 生效 / `superseded` 已取代 / `archived` 已停用；历史不会被静默丢掉 |
| **关系** | `related` / `refines` / `depends` / `contradicts`，可带备注，图谱与详情里都会显示 |
| **稳定度** | `stabilityDays` 是半衰期：多少天后记住的概率降到 50% |

## 遗忘曲线

留存率：

```
R = 0.5 ^ (距上次确认的天数 / stabilityDays)
```

- 阶段：`fresh` ≥ 80%（新鲜）、`stable` ≥ 50%（稳定）、`fading` ≥ 20%（淡化）、`dormant` < 20%（沉寂）
- 复习（用户确认仍然成立）：稳定度 × 1.8，上限 730 天，重置留存时钟
- 被注入（模型看到）：稳定度 × `1 + 0.25 × (1 - R)`，越难想起，加固越多
- 固定（pin）：稳定度下限 × 4；沉寂条目默认不注入，但仍可检索
- **任何阶段都不会自动删除**；越久没确认，只是越不容易出现在上下文里

会话里的检索结果会带留存率，模型被要求：留存率偏低时先向用户确认，再调用 `memory_review`。

## 关系图谱

节点是库与条目，边有六类：

| 边 | 来源 |
|---|---|
| `contains` | 条目归属库 |
| `supersede` | 取代链，旧 → 新 |
| `relation` | 显式关系，带子类型与备注 |
| `topic` | 同主题族（topic 首段相同），按时间近邻连接 |
| `tag` | 共享标签，每个节点最多 3 条，避免毛球 |
| `bank-link` | 库关联（注入 / 可检索） |

派生边是有界启发式：同一标签下按最近更新连成链，而不是两两连成团。选中节点会暂停自动旋转并聚焦；抽屉打开时图谱中心左移，避免被遮挡。

## 安装

前提：DSH Desktop、仓库已放到本地目录。运行时使用 DSH 自带的 Node 24（内置 `node:sqlite`）；若用系统 Node 手动启动控制台，需要支持 `node:sqlite` 的版本。

```powershell
# <dsh> 是 DSH 安装目录下的 CLI，例如 D:\DSHarness\resources\runtime\cli\bin\dsh.cmd
& '<dsh>' plugin --profile desktop add "link:D:\path\to\MemStack"
```

该命令会写入 profile 的 `dependencies` 与 `dsh.profile.bundles`，随后热重组生效，**无需重启**。

数据存放在 `$DSH_HOME/memstack/memstack.db`（默认 `C:\Users\<你>\.dsh\memstack\memstack.db`），由 Node 内置的 `node:sqlite` 驱动，WAL 模式，没有额外 npm 依赖。旧版 `state.json` 会在首次启动时自动导入，并改名为 `state.json.migrated-<时间戳>.bak`；之后不再读取 JSON 作为真源。

## 工具

| 工具 | 用途 |
|---|---|
| `memory_write` | 记录决策 / 约束 / 踩坑 / 偏好 / 未决问题；同 topic 自动取代 |
| `memory_search` | 跨库关键词检索（受关联的 `query` 权限约束），结果带留存阶段 |
| `memory_read` | 读取单条全文、替代链、关系与衰减信息 |
| `memory_forget` | 停用（默认，可恢复）或删除；删除会恢复被它取代的前驱 |
| `memory_review` | 用户确认“仍然成立”后重置曲线；`outdated` 则停用 |
| `memory_relate` | 建立/移除两条记忆之间的关系 |
| `memory_inventory` | 列出全部条目、状态与留存率 |

写入示例：

```json
{
  "topic": "spdk.ingest-path",
  "kind": "decision",
  "claim": "采用独立守护进程读取设备，放弃 pre_load 注入",
  "detail": "pre_load 在目标时机拿不到设备句柄，实测失败；守护进程经共享内存通信，已验证。",
  "rejected": [
    { "option": "pre_load 注入", "reason": "目标时机拿不到设备句柄" }
  ],
  "tags": ["spdk", "ingest"]
}
```

会话里注入给模型的样子：

```
[决策] spdk.ingest-path — 采用独立守护进程读取设备，放弃 pre_load 注入
  ✗ 已否决：pre_load 注入（目标时机拿不到设备句柄）
```

## 控制台

默认地址 **http://127.0.0.1:7788**，由插件自动启动；手动启动：

```powershell
npm run console
```

| 页面 | 内容 |
|---|---|
| **图谱** | 3D 力导向关系网；按库/类型/状态/边筛选；搜索高亮；点击查看详情 |
| **记忆** | 按留存率浏览；搜索、库/状态/类型筛选、排序；固定、编辑、删除 |
| **记忆库** | 库卡片（条目/生效/平均留存）；新建主题库、改名、停用；库关联矩阵 |
| **数据** | 导出 JSON bundle / Markdown；拖拽导入；显示当前 SQLite 库路径；留存与类型分布；待复习队列 |

条目抽屉包含：留存曲线、详情、否决理由、关系、替代链、元信息，以及“仍然成立 / 标记过时 / 编辑 / 删除 / 固定”等操作。

页面状态写在地址栏，可直接分享或刷新还原：`#graph`、`#memories`、`#banks`、`#data`，打开条目时为 `#entry=<id>`。

![条目详情](docs/assets/entry-drawer.png)

浅色主题：

![浅色主题](docs/assets/light.png)

### 演示数据

不碰真实数据，用隔离的 `.demo/` 目录起一份 30 条记忆的演示：

```powershell
npm run demo
# http://127.0.0.1:7799
```

## 迁移与备份

控制台「数据」页可以直接导出/导入；导入前会用 SQLite 在线备份 API 在同目录写 `memstack.db.<时间戳>.bak`。日常备份推荐导出 bundle；如果直接复制数据库文件，请先退出 Host 与控制台，或连同 `-wal`/`-shm` 一起复制。

旧版 JSON 数据不需要手动转换：升级前先停掉旧版 Host 与控制台（旧进程仍会写 `state.json`），再启动新版；若发现 `$DSH_HOME/memstack/state.json` 且数据库尚不存在，会先完整导入 SQLite，再把 JSON 改名为 `.migrated-*.bak`。迁移失败时不会留下空数据库，原 JSON 保持不动，便于排查后重试。

CLI：

```powershell
# 导出全部历史（JSON bundle）
npm run export -- --out memstack.bundle.json

# 只导出某个库
npm run export -- --out spdk.bundle.json --bank spdk-storage

# 导入前先看报告
npm run import -- memstack.bundle.json --dry-run

# 合并（默认）或整库替换
npm run import -- memstack.bundle.json --mode merge
npm run import -- memstack.bundle.json --mode replace
```

合并语义：**绝不静默丢结论**。

- 同 id 且同内容 → 跳过（重复导入幂等）
- 同 id 不同内容 → 分配新 id，关系/取代链一并重映射
- 同库同 topic 已有不同结论 → 导入项存为 `archived`，报告 `topic-taken`，本地结论不被覆盖
- 目标库不存在 → 按 id 或 `kind + title` 匹配；匹配不到则新建
- `replace` 会清空本地内容，控制台要求二次确认

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖：

```yaml
- id: memstack
  name: "@local/memstack"
  config:
    injectIndex: true          # 是否注入记忆索引
    indexByteBudget: 4096      # 索引字节预算
    recallTopK: 40             # 索引最多条数
    injectGlobalBank: true     # 是否默认注入 global 库
    consoleEnabled: true       # 是否随插件启动控制台
    consolePort: 7788
```

## 工作原理

1. `agent/pre-step` 里组装一条 sourced 用户消息（`<system-reminder>` 包裹），`toSpliced` 进本轮请求；
2. 消息来源保存条目快照，下一轮按 `(bank, topic)` 比对，只注入差异；
3. 取代写作被渲染成“更新 + 已失效”，而不是“新增 + 删除”；
4. 注入只追加、不重写历史，KV cache 友好；
5. 状态真源是 `$DSH_HOME/memstack/memstack.db`；插件与控制台通过 SQLite `revision` 感知外部提交，写入走 `BEGIN IMMEDIATE`，不会用静默覆盖解决并发。

## 目录结构

```
index.js            Host 插件入口（apply）
lib/                纯核心：store / database / decay / render / graph / portable / query / tools / inject / console
console/            本地控制台（server.mjs + app.js + graph3d.js + styles.css）
test/               单元与集成测试（含真实 HTTP 控制台与 SQLite 迁移/并发）
docs/               设计、开发、路线图与截图
cordis.patch.yml    bundle 插入行
```

## 开发

零运行时依赖、无构建步骤；控制台在离线环境也能打开。

```powershell
npm test          # node --test，91 项
npm run console   # 单独启动控制台
npm run demo      # 隔离演示数据（重新播种 SQLite）
```

Host 代码改动后，改一行 profile 的 `cordis.patch.yml` 可触发 HMR 重组；控制台改完刷新页面即可。测试固定时钟，避免真实时间让留存率漂移。

- 设计文档：[docs/design.md](docs/design.md)
- 开发文档（分片实施、spike 结论）：[docs/development.md](docs/development.md)
- v2 路线与取舍：[docs/roadmap-v2.md](docs/roadmap-v2.md)

## 状态

v3 已完成：SQLite 持久化（`node:sqlite`，WAL + revision 冲突检测 + 增量写入）、旧 `state.json` 自动迁移、在线备份；v2 的取代链与可追溯注入、遗忘曲线与复习、3D 图谱、条目/库/数据控制台、JSON bundle 与 Markdown 导出、merge/replace 导入、浅色主题、中英文界面、真实 HTTP 集成测试继续保留。

未做（有意留到需要时）：embedding 语义检索、多人协同、DSH 设置页内的原生页面、自动整理器（合并近似条目 / TTL）、FTS5 中文分词。

## License

[MIT](LICENSE)
