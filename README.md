# dsh-cross-device-sync

DSH 的跨设备同步插件：**配置走 git，会话历史走文件同步**，并带台账冲突检测、zstd 分帧完整性校验与自动触发。

解决的问题：DSH 跑在多台机器上，而 `$DSH_HOME` 里既有几百 KB 的文本配置，也有几百 MB 且只增不减的会话日志。前者适合 git，后者放 git（哪怕 LFS）会被 100 MB 单文件上限、1 GB/月 LFS 流量和历史膨胀拖死。所以分成两条通道，各用各的机制。

## 为什么这么设计（三个已核对的事实）

1. **会话日志是 append-only 的 zstd 分帧文件**：一个会话一个文件（`sessions/<projectKey>/<sessionId>/session.v3.jsonl.zstd`），追加写、从不改写。所以「整文件复制」天然无冲突；文本合并完全不可行。
2. **写所有权是本机的**：`open(id,'write')` 取进程内单写者，JSONL 后端再加内核级文件租约——**跨不了机器**。所以跨设备顺序必须靠纪律 + 台账。
3. **resume 用日志里记录的 `cwd`，且不校验存在性**：路径在本机不存在时不会在恢复那一刻报错，而是拖到第一次文件/命令调用才失败。路径靠 `devices.yaml` 对齐。

顺序使用（不在两台设备同时对话）时不存在并发写，真正的风险是**未同步窗口**：另一台设备已经追加、而本机仍拿着旧副本继续写。台账就是拿来检出它的。

## 架构：一个包，两个半边

| 半边 | 入口 | 运行位置 | 职责 |
| --- | --- | --- | --- |
| Host | `src/index.js`（`main`） | DSH 的 Node 进程 | 同步引擎、git 操作、台账、完整性校验、事件与定时触发 |
| Client | 待实现（`./client` + `dsh.client`） | 浏览器 | `sidebar.panellist` 入口图标 + `main` 设备面板 + 设置页 |

两者通过包内私有 RPC 通信（Host `harness.handle` / Client `host.call`），不新开公共服务。

## 安装

```powershell
# 本地开发（不发布也能装）
dsh plugin --profile web add link:D:\Desktop\dsh-cross-device-sync

# 发布后
dsh plugin --profile web add dsh-cross-device-sync
```

`cordis.patch.yml` 负责把插件行插进 profile 的清单，装完重启 profile 生效。

## 使用

```powershell
node bin/dsh-sync.mjs init            # 每台设备一次：生成 .device-id 与 .dsh-sync/
node bin/dsh-sync.mjs status          # 盘点：会话数、台账、冲突、远端更新、git 状态
node bin/dsh-sync.mjs verify --full   # 逐帧完整性校验（怀疑损坏时用）
node bin/dsh-sync.mjs pull            # 预检 → git pull --ff-only → 更新台账
node bin/dsh-sync.mjs push            # 预检 → 更新台账 → add/commit/push
node bin/dsh-sync.mjs sync            # pull + push
```

退出码：`0` 正常 · `2` 冲突 · `3` git 问题 · `4` 日志完整性问题。任意子命令可加 `--dry-run`。

挂上 Host 插件后，同步会在这些时机自动发生：

- **回合收尾**：`agent/status` → `idle`（合并窗口 `debounceSeconds`，默认 20 秒）
- **对话结束**：`session/disposed`
- **定时**：`intervalMinutes > 0` 时按间隔执行
- 挂载时做一次盘点，结果写到 `.dsh-sync/status.json`（供将来的 UI 面板读取）

## 配置

插件行的 config 与 `.dsh-sync/config.json` 合并，后者优先级更高：

```json
{
  "enabled": true,
  "onTurnEnd": true,
  "onSessionEnd": true,
  "intervalMinutes": 0,
  "debounceSeconds": 20
}
```

## 分层：什么进 git，什么走文件同步

| 内容 | 通道 |
| --- | --- |
| `settings.yaml`、`skills/`、`.agent-presets/`、`devices.yaml`、`SYNC.md`、本插件 | git（`$DSH_HOME` 本身当仓库） |
| `sessions/`、`.dsh-sync/` | 文件同步（Syncthing 等，只同步这两个） |
| `storages/`、`task-board/` | 不同步（含绝对路径、就地改写型） |
| `profiles/` | 不同步（每台设备 `dsh plugin add` 重装） |
| `.device-id`、`.credentials.yaml`、`.anonymous-user-id` | **绝不进任何通道** |

## 路线图

- [x] Host 半边：同步引擎、台账、完整性校验、三个触发点、状态文件
- [x] CLI（与 Host 共用 `src/engine.js`，行为一致）
- [ ] Client 半边：`sidebar.panellist` 图标 + `main` 设备面板（设备列表、远端会话只读浏览、同步状态与手动触发）
- [ ] 类型化构建：TS 源码 + `tsc`/`tsdown`，`Config` 用 schemastery 校验，`main` 切到 `lib/`
- [ ] 跨设备继续会话：合并 `workspace.json`（按设备重写 path）、路径映射生效、非本机会话默认只读 / 可 fork
- [ ] 设置页：git 账号与 token 走 `ctx.credentials`，同步策略在 UI 里配

## 明确不做

- 不改会话日志内容（它是历史记录）。
- 不 `--force` 解决任何冲突。
- 不自动合并两端都追加过的日志文件。
- 不同步密钥与本机身份。

## 已知边界

- 同步来的会话**不会自动出现在 GUI 侧栏**：那个列表来自 persistence 后端（单一必填 `root`）。阶段 2 用自己的面板绕过；阶段 4 才可能做成原生可见。
- 本插件目前是**纯 JS、零外部依赖**（只用 `node:*`），所以拷过去就能跑；代价是插件行 config 没有 schemastery 校验（阶段 3 补）。

## 许可

MIT
