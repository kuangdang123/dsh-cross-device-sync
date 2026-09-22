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
| Host | `src/index.js`（`main`） | DSH 的 Node 进程 | 同步引擎、git 操作、台账、完整性校验、事件与定时触发、HTTP 路由 |
| Client | `lib/client.js`（`./client`） | 浏览器 | `sidebar.panellist` 入口图标 + `main` 设备面板（设备筛选、会话列表、手动同步） |

两边的唯一通道是本包自己的 HTTP 路由 `/cross-device-sync/{status,sessions,run}`，只接受 **loopback 套接字 + loopback Host 头**（与 `dsh-ssh` / git-graph 同一套信任围栏），不新开 Cordis 公共服务。

### 客户端产物

`lib/client.js` 是官方约定的闭包工厂：以 `window.__ModuleLoader__.load({ id, factory })` 开头，`factory` 收到同步的 `require`（模块表），只能取平台基线 `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。

客户端半边是 CommonJS 源码 `src/client/index.cjs`（只用 React，无 CSS Modules），由**零依赖**的 `build/build-client.mjs` 包一层生成产物——不需要 tsdown / lightningcss / monorepo 构建预设。将来要写 TSX 或 CSS Modules 时，改为复制官方预设 `packages/client/tsdown.client.ts` + `build/web/src/platform.ts` 并保持同步。

## 安装

```powershell
# 1) 生成本地客户端产物（零依赖，产物入库）
node build/build-client.mjs

# 2) 本地开发（不发布也能装）
dsh plugin --profile web add link:D:\Desktop\dsh-cross-device-sync

# 发布后
dsh plugin --profile web add dsh-cross-device-sync
```

`cordis.patch.yml` 负责把插件行插进 profile 的清单，装完重启 profile 生效；改客户端代码后要重新 `build:client` 并刷新页面（Vite 不参与动态插件产物）。

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
- [x] Host HTTP 路由：`/status`、`/sessions`、`/run`（loopback 围栏 + 冒烟测试）
- [x] Client 半边：`sidebar.panellist` 图标 + `main` 设备面板（设备筛选、会话列表、手动同步）
- [ ] 类型化构建：TS/TSX 源码 + 官方 tsdown 预设，`Config` 用 schemastery 校验，`main` 切到 `lib/`
- [ ] 跨设备继续会话：合并 `workspace.json`（按设备重写 path）、路径映射生效、非本机会话默认只读 / 可 fork
- [ ] 设置页：git 账号与 token 走 `ctx.credentials`，同步策略在 UI 里配
- [ ] i18n：面板文案走 `ctx.locale` 字典（现在是内联中文）

## 明确不做

- 不改会话日志内容（它是历史记录）。
- 不 `--force` 解决任何冲突。
- 不自动合并两端都追加过的日志文件。
- 不同步密钥与本机身份。

## 已知边界

- 同步来的会话**不会自动出现在 GUI 侧栏**：那个列表来自 persistence 后端（单一必填 `root`）。本插件的 `设备同步` 面板能列出并筛选它们（数据来自 `/sessions` 路由），但"像本地会话一样点开继续"要等路线图第 6 项。
- 面板列的是**本地可见**的会话文件：另一台设备的会话必须已经同步到位才会出现；面板里的设备筛选按台账归属区分。
- 本插件目前是**纯 JS、零外部依赖**（Host 只用 `node:*`，Client 只用模块表里的 `react`），所以拷过去就能跑；代价是插件行 config 没有 schemastery 校验、面板文案没有走 i18n（都在路线图里）。

## 许可

MIT
