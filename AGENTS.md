# MemStack 项目规定

> 本文件由 DSH 的 `dsh-agent-instructions` 注入（项目根 = 含 `.git` 的目录）。
> 优先级：用户当前指令 > 本文件 > `docs/*`。冲突时以代码和用户指令为准。

## 1. 项目是什么

DSH（DeepSeek Harness）的 workspace 级记忆库插件：Host 插件 + 本地控制台 + SQLite 存储。

| 路径 | 职责 |
|---|---|
| `index.js` | Host 入口 `apply(ctx, config)`：装配 store、注册工具、注入、拉起控制台 |
| `lib/store.js` `lib/decay.js` `lib/graph.js` `lib/render.js` | 纯核心，零依赖，不 import `@deepseek-ai/*` |
| `lib/database.js` | `node:sqlite` 适配：schema、增量提交、revision、迁移、备份 |
| `lib/tools.js` `lib/inject.js` `lib/query.js` | 工具注册、pre-step 注入、检索 |
| `console/*` | 独立本地控制台（127.0.0.1），直接读写同一个库 |
| `test/*` | `node --test`，零依赖、不联网 |

## 2. 安全红线（2026-11-03 事故后新增，最高优先级）

事故经过：一条命令结尾用 `Remove-Item -LiteralPath $home -Recurse -Force`，而 `$home` 是 PowerShell 只读自动变量，恒等于 `%USERPROFILE%`；结果整个 `C:\Users\admin` 被递归删除，DSH 与 opencode 的安装、配置、会话一起消失。详见 `docs/development.md` §14。

**硬性规定：**

1. **禁止用 `home` 当变量名。** `$home`、`$HOME`、`$profile`、`$env`、`$input` 都是 PowerShell 自动变量；给它们赋值只会报错并被忽略，后续拿到的仍是真实路径。临时目录变量一律命名 `$testHome` / `$tempHome` / `$sandbox`。
2. **禁止对任何非临时目录递归删除。** 不用 `Remove-Item -Recurse`、`rd /s`、`del /s`，也不在脚本里直接 `rmSync(dir, { recursive: true })`。唯一允许的入口是：
   ```powershell
   node scripts/home.mjs reset <path>   # realpath 后断言目标在 $env:TEMP 内，且不是受保护目录的祖先
   ```
3. **临时 home 只用脚本创建**：`node scripts/home.mjs new` 打印路径，不要手拼 `$env:TEMP\...`。
4. **删除前先验证**：`node scripts/home.mjs check <path>`，看它打印的解析后绝对路径，再决定。
5. **一条命令只做一件事**：导出 / 检查 / 删除分开执行。不要把多个动作串成 1000+ 字符的一次性长命令——审批框里看不出变量真实取值，事故就埋在这里。
6. **动 `~/.dsh`、profile、`AppData` 前先备份**：`node scripts/home.mjs backup`（默认写 `D:\dsh-backups`，与 C: 不同卷，避免同归于尽）。
7. **不主动删除/覆盖 `C:\Users\admin` 下的任何内容。** 需要改 profile 或 `~/.dsh` 时只做最小编辑，并先备份。
8. **不允许"先删再验证"**：涉及库、home、profile 的操作，先复制/备份，再动手。

## 3. 开发循环

- **L1（秒级）**：`node --test`。任何缺陷先在 L1 复现成测试，再改代码。
- Node 用 DSH 自带的，不在 PATH：
  ```powershell
  $node = 'C:\Users\admin\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
  & $node --test
  ```
- 测试必须：零依赖、不联网、不读写真实的 `~/.dsh`；临时目录用 `mkdtemp` 或 `scripts/home.mjs new`，并在 `finally` / `t.after` 清理。
- **L2（分钟级）**：安装/升级插件会重启 Host、打断当前会话 → 属于"需要用户在场"的检查点，先问再做。

## 4. 代码约定

1. ESM，`type: "module"`，无 TS 构建。
2. 纯核心（store/decay/graph/render）零依赖、纯函数、时间与 id 由参数注入。
3. 所有写操作走 store 方法；落盘只走 `commitStore(db, store, { expectedRevision })`；冲突抛 `state-conflict:`，不吞错。
4. 内存 state 保持纯 JSON（无函数、无 Date 实例）。
5. 用户可见文案走 `locale/*.json`；Host 内部错误信息用英文常量，便于检索。
6. 改行为必须同步文档：`docs/design.md`（契约）、`docs/development.md`（实施记录与踩坑）。

## 5. 数据与安装

- 数据目录：`$DSH_HOME/memstack/memstack.db`（WAL）。**禁止**把 `DSH_HOME` 设成 `%USERPROFILE%` 本身——这正是事故前 `C:\Users\admin\memstack\` 出现的形态。
- 安装：`dsh plugin --profile desktop add "link:D:\dsh-memstack"`，会把包名写进 profile 的 `dsh.profile.bundles`。
- 卸载：`dsh plugin --profile desktop remove @local/memstack`；卸载不删数据。
- 插件与 Host 同进程：Host 代码改动需重启，Client 改动刷新页面。

## 6. 提交

- 不提交：`node_modules/`、`.demo/`、`_tmp/`、`*.db`、`*.db-wal`、`*.db-shm`、`*.bak`。
- message 用 `feat:` / `fix:` / `docs:` / `test:` / `chore:` 前缀，一句话说清行为变化。
