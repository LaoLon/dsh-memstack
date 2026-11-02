# MemStack

> 给 [DeepSeek Harness](https://github.com/deepseek-ai) 的**工作区级记忆库**：记录项目当前仍然成立的判断，而不是对话摘要。

旧结论能被新结论**取代**，被否掉的方案连同原因一起留着，每次变更都会在对话里留下可追溯的记录——这是它和"云端记忆"最大的区别。

## 它解决什么问题

云端记忆的典型故障：你试过方案 A 发现不行，改用方案 B，但记忆里 A 还在，模型之后反复建议 A，而你没法定点删除。

根因有四条：自动写入无门槛、只有追加没有覆盖、全局共享、不可见不可删。MemStack 的对策：

| 问题 | 做法 |
|---|---|
| 新旧结论并存 | 同一 `topic` 只允许一条生效；写入新结论时旧的自动变 `superseded` |
| 模型反复推荐旧方案 | 旧条目保留 `rejected[]`（被否决的选项 + 原因），注入时明确标注「已失效，不要再建议」 |
| 全局污染 | 记忆按工作区隔离；跨库默认只可检索，不默认注入 |
| 看不见、改不动 | 本地控制台可视化查看、编辑、停用、删除 |

## 核心概念

| 概念 | 说明 |
|---|---|
| **Bank（记忆库）** | 一组记忆的容器。每个工作区一个 `workspace` 库，另有跨项目的 `topic` 库与单例 `global` 库 |
| **Entry（条目）** | 一条判断：`topic` + `claim`（一句话结论）+ `detail` + `rejected[]`，带来源会话 |
| **Topic（主题键）** | 稳定标识，如 `spdk.ingest-path`。同一 topic 只有一条 `active` |
| **状态** | `active` 生效 / `superseded` 已取代 / `archived` 已停用 / `candidate` 候选 |

## 功能

- **写入与取代**：`memory_write` 自动查同 topic 并取代旧结论，返回 `created` / `superseded` / `duplicate`
- **注入**：会话首次请求注入索引（预算内只放结论），记忆变化时追加「新增 / 更新并废止旧结论 / 废止」通知
- **检索**：`memory_search` / `memory_read` 按需读取全文，避免每轮烧 token
- **管理**：`memory_forget`（停用可恢复；删除会恢复被它取代的前驱）、`memory_inventory`（全状态清单）
- **本地控制台**：库与条目可视化，支持新建主题库、改名、描述、停用/启用、删除、关联矩阵、中英文切换
- **自动拉起**：插件激活时启动控制台，端口被占用则复用，插件卸载时关闭

## 安装

前提：DSH Desktop（在 44.x 上开发与验证）、仓库已放到本地目录。

```powershell
# <dsh> 是 DSH 安装目录下的 CLI，例如 D:\DSHarness\resources\runtime\cli\bin\dsh.cmd
& '<dsh>' plugin --profile desktop add "link:E:\Code\MemStack"
```

该命令会写入 profile 的 `dependencies` 与 `dsh.profile.bundles`，随后热重组生效，**无需重启**。

数据存放在 `$DSH_HOME/memstack/state.json`（默认 `C:\Users\<你>\.dsh\memstack\state.json`），纯 JSON，可直接备份。

## 使用

| 工具 | 用途 |
|---|---|
| `memory_write` | 记录决策 / 约束 / 踩坑 / 偏好；同 topic 自动取代 |
| `memory_search` | 跨库关键词检索（受关联的 `query` 权限约束） |
| `memory_read` | 读取单条全文 |
| `memory_forget` | 停用（默认，可恢复）或删除 |
| `memory_inventory` | 列出全部条目与状态 |

写入示例：

```json
{
  "topic": "spdk.ingest-path",
  "kind": "decision",
  "claim": "采用独立守护进程读取设备，放弃 pre_load 注入",
  "detail": "pre_load 在目标时机拿不到设备句柄，实测失败；守护进程经共享内存通信，已验证。",
  "rejected": [
    { "option": "pre_load 注入", "reason": "目标时机拿不到设备句柄" }
  ]
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

- 库：新建主题库、改名、描述、停用/启用、删除
- 条目：搜索、按状态/库筛选、固定、停用/启用、删除、展开查看否决理由与取代链
- 关联：选择源库，为其它库单独设置「注入 / 可检索」
- 语言：右上角 `EN / 中文`，只切换界面文案，不改动记忆内容

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖：

```yaml
- id: memstack
  name: "@local/memstack"
  config:
    indexByteBudget: 4096      # 索引字节预算
    recallTopK: 40             # 索引最多条数
    injectGlobalBank: true     # 是否默认注入 global 库
    consoleEnabled: true       # 是否随插件启动控制台
    consolePort: 7788
```

## 工作原理

1. `agent/pre-step` 里组装一条 sourced 用户消息（`<system-reminder>` 包裹），`toSpliced` 进本轮请求；
2. 消息来源保存条目快照，下一轮按 `(bank, topic)` 比对，只注入差异；
3. 取代写作被渲染成「更新 + 已失效」，而不是「新增 + 删除」；
4. 注入只追加、不重写历史，KV cache 友好；
5. 状态真源是一个 JSON 文件，插件与控制台通过 mtime 感知外部修改。

## 目录结构

```
index.js            Host 插件入口（apply）
lib/                纯核心：store / render / sync / query / tools / inject / persist / console
console/            本地控制台（server.mjs + index.html）
test/               单元与集成测试
docs/               设计文档与开发文档
cordis.patch.yml    bundle 插入行
```

## 开发

```powershell
npm test          # node --test，42 项
npm run console   # 单独启动控制台
```

Host 代码改动后，改一行 profile 的 `cordis.patch.yml` 可触发 HMR 重组；客户端（控制台）改完刷新页面即可。

- 设计文档：[docs/design.md](docs/design.md)
- 开发文档（分片实施、spike 结论）：[docs/development.md](docs/development.md)

## 状态

已完成：写入/取代、注入与变更通知、检索与管理工具、控制台（库/条目/关联）、自动拉起。

未完成：整理器（合并近似条目 / stale / TTL）、Markdown 导出、DSH 设置页内的原生页面（依赖 Typert 代码生成，需要 DSH 源码 checkout）。

## License

[MIT](LICENSE)
