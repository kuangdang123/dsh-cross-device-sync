# dsh-cross-device-sync

DSH 的跨设备同步插件：**`$DSH_HOME` 单仓走 git**（配置与会话同一条历史，远端建议用专用会话仓库），
并带台账冲突检测、zstd 分帧完整性校验、**敏感文件硬闸门**与自动触发。

解决的问题：DSH 跑在多台机器上，而 `$DSH_HOME` 里既有几百 KB 的文本配置，也有几百 MB 且只增不减的会话日志。
本插件把它们放进**同一个 git 仓库**（`$DSH_HOME` 本身当仓库），用**体积闸门**（单文件 90 MB 拒绝、仓库超 800 MB 预警）
与 `compact`（压成单快照）控制增长；`profiles/`、`storages/` 等机器本地目录由受管 `.gitignore` 区块排除。
若你更愿意让会话走文件同步（Syncthing 等），把 `sessions/` 加进自己的 ignore 即可——插件不依赖那条通道。

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
# 1) 生成本地客户端产物（零依赖；lib/ 是构建产物，不入库，克隆后必须先建一次）
node build/build-client.mjs

# 2) 本地开发（不发布也能装）
dsh plugin --profile web add link:D:\Desktop\dsh-cross-device-sync

# 发布后
dsh plugin --profile web add dsh-cross-device-sync
```

`prepublishOnly` 会在 `npm publish` 前自动重建客户端产物，所以发布出去的包一定带 `lib/client.js`。

`cordis.patch.yml` 负责把插件行插进 profile 的清单，装完重启 profile 生效；改客户端代码后要重新 `build:client` 并刷新页面（Vite 不参与动态插件产物）。

## 使用

```powershell
node bin/dsh-sync.mjs init            # 每台设备一次：生成 .device-id 与 .dsh-sync/
node bin/dsh-sync.mjs status          # 盘点：会话数、台账、冲突、远端更新、git 状态
node bin/dsh-sync.mjs verify --full   # 逐帧完整性校验（怀疑损坏时用）
node bin/dsh-sync.mjs pull            # 预检 → git pull --ff-only → 更新台账
node bin/dsh-sync.mjs push            # 预检 → 更新台账 → add/commit/push
node bin/dsh-sync.mjs sync            # pull + push
node bin/dsh-sync.mjs prune           # 列出被归档的会话（默认只列不删）
node bin/dsh-sync.mjs prune --apply   # 移入 .dsh-sync/trash/（可恢复）
node bin/dsh-sync.mjs prune --empty-trash  # 清空回收站（唯一真正删除归档会话的地方）
node bin/dsh-sync.mjs compact         # 把仓库历史压成单个快照（体积治理）
```

退出码：`0` 正常 · `2` 冲突 · `3` git 问题 · `4` 日志完整性问题 · `5` 安全闸门（敏感/机器本地文件进了 git）。任意子命令可加 `--dry-run`。

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

| 内容 | 处理 | 依据 |
| --- | --- | --- |
| `settings.yaml`、`skills/`、`.agent-presets/`、`devices.yaml`、`SYNC.md`、本插件 | **进 git** | 小文本，跨设备要一致 |
| `sessions/`（含子代理日志）、`attachments/` | **进 git** | 这就是会话仓库存在的理由；单文件 >90 MB 会被闸门拒绝 |
| `.dsh-sync/ledger-*.json`、`.dsh-sync/config.json` | **进 git** | 冲突检测要跨设备可见 |
| `.dsh-sync/status.json`、`host-mount.json`、`.dsh-sync/trash/` | 不进（机器本地 / 每次改写） | 进了工作区会永远脏 |
| `profiles/`、`electron/`、`cache/`、`logs/`、`tools/`、`dsh-pet/`、`storages/` | 不进（机器本地、体积大、含绝对路径） | 每台设备自己生成或 `dsh plugin add` 重装 |
| `.credentials.yaml`、`.device-id`、`.anonymous-user-id` | **绝不进任何通道** | 身份与密钥；推上远端后删除也抹不掉历史 |

> 早期设计留过「会话走 Syncthing」这条备选通道；当前版本只实现 git 一条，文件同步不再是必需。

## 安全闸门：敏感文件绝不进仓库

只写 `.gitignore` 不够——用户手改一次就破防，而记录一旦推上去就抹不掉了。所以有两道：

1. **受管 ignore 区块**（`syncManagedIgnores`）：敏感身份 / 机器本地与体积 / 归档会话，三类带标记的区块自动维护。
2. **硬闸门**（`guardNeverSync`）：写完 ignore 之后，用 `git ls-files` 与 `git status --porcelain -uall`
   复核"已跟踪的"和"`git add -A` 会吃进去的"路径；任一命中「绝不同步」名单就**拒绝提交**。

`status` 会列出命中项；`push` / `sync` 命中时以**退出码 5** 失败。修法：

```powershell
git -C "$env:USERPROFILE\.dsh" rm --cached .credentials.yaml
```

如果凭据已经推上远端：**先吊销该密钥**，再考虑 `git filter-repo` 重写历史（删除文件不改变已推送的历史）。

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
- **会话进 git 会让仓库增长**：zstd 日志是二进制，git 无法跨版本 delta，每次同步都把变更文件整份存一层；
  超 800 MB 会有预警，用 `dsh-sync compact --yes` 压成单快照（**另一台设备必须重新 clone 或 `git reset --hard`**）。
- 本插件目前是**纯 JS、零外部依赖**（Host 只用 `node:*`，Client 只用模块表里的 `react`），所以拷过去就能跑；代价是插件行 config 没有 schemastery 校验、面板文案没有走 i18n（都在路线图里）。

## 许可

MIT
