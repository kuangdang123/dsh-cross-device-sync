/**
 * Host 半边：在 DSH 的 Node 进程里驱动同步。
 *
 * 职责边界（很重要）：
 *   - 这里只做「文件 + git + 事件 + 定时」；UI 属于 Client 半边，通过包内私有 RPC 取数。
 *   - 触发点是回合收尾与对话结束，不是每次事件——config 里的 debounceSeconds 决定合并窗口。
 *   - 任一步失败都只记录并报告，不吞异常、不自动合并、不 force。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { deviceId, preflight, resolveHome, status as engineStatus, sessionSummaries, sync, writeLedger, writeMountMarker, git, isRepo, hasRemote } from './engine.js'
import { registerRoutes } from './routes.js'

export const name = 'cross-device-sync'
export const inject = []

/** 本文件所在目录，写进挂载标记，便于确认“跑的是哪份代码”。 */
const packagePath = import.meta.dirname

const DEFAULTS = Object.freeze({
  enabled: true,
  onTurnEnd: true,
  onSessionEnd: true,
  intervalMinutes: 0,
  debounceSeconds: 20,
})

function loadConfig(ctx, home, rowConfig) {
  const file = join(home, '.dsh-sync', 'config.json')
  let fileConfig = {}
  if (existsSync(file)) {
    try {
      fileConfig = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      ctx.logger?.warn?.(`cross-device-sync: 忽略无法解析的 ${file}：${error}`)
    }
  }
  return { ...DEFAULTS, ...fileConfig, ...(rowConfig ?? {}) }
}

export function apply(ctx, rowConfig = {}) {
  const home = resolveHome()
  const config = loadConfig(ctx, home, rowConfig)
  const log = ctx.logger ?? console
  if (!config.enabled) {
    log.info?.('cross-device-sync: 已禁用（.dsh-sync/config.json 或插件行配置 enabled=false）')
    return
  }

  let device
  try {
    device = deviceId(home)
  } catch {
    device = deviceId(home, { create: true })
    log.info?.(`cross-device-sync: 已生成本机设备身份 ${device}，请把它填进 devices.yaml`)
  }

  let pending = null
  let running = false
  let dirty = false
  const stateDir = join(home, '.dsh-sync')
  const statusFile = join(stateDir, 'status.json')

  const writeStatus = payload => {
    try {
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(statusFile, JSON.stringify({ device, at: new Date().toISOString(), ...payload }, null, 2))
    } catch (error) {
      log.warn?.(`cross-device-sync: 写状态文件失败：${error}`)
    }
  }

  const runNow = reason => {
    if (running) {
      dirty = true
      return
    }
    running = true
    try {
      const result = sync(home)
      const pre = result.preflight
      if (result.error !== null) {
        log.warn?.(`cross-device-sync: 同步失败（触发自 ${reason}）：${result.error}`)
      } else {
        log.info?.(
          `cross-device-sync: 同步完成（触发自 ${reason}）pull=${result.pulled} commit=${result.committed} push=${result.pushed}`,
        )
      }
      writeStatus({
        reason,
        ok: result.error === null,
        error: result.error,
        pulled: result.pulled,
        committed: result.committed,
        pushed: result.pushed,
        conflicts: pre?.conflicts?.map(c => c.rel) ?? [],
        integrityProblems: pre?.integrity?.length ?? 0,
        pendingRemote: pre?.missing?.length ?? 0,
      })
    } finally {
      running = false
      if (dirty) {
        dirty = false
        schedule('follow-up')
      }
    }
  }

  const schedule = reason => {
    const delay = Math.max(0, Number(config.debounceSeconds) || 0) * 1000
    if (delay === 0) {
      runNow(reason)
      return
    }
    if (pending !== null) clearTimeout(pending)
    pending = setTimeout(() => {
      pending = null
      runNow(reason)
    }, delay)
    if (typeof pending.unref === 'function') pending.unref()
  }

  // ── 触发点 ────────────────────────────────────────────────────────────────
  if (config.onTurnEnd) {
    ctx.on('agent/status', payload => {
      if (payload?.status === 'idle') schedule('turn-end')
    })
  }
  if (config.onSessionEnd) {
    ctx.on('session/disposed', () => schedule('session-end'))
  }
  const intervalMinutes = Number(config.intervalMinutes) || 0
  if (intervalMinutes > 0) {
    const timer = ctx.get('timer')
    if (timer !== undefined) {
      ctx.effect(() => timer.interval(() => schedule('interval'), intervalMinutes * 60_000), 'cross-device-sync interval')
    } else {
      const handle = setInterval(() => schedule('interval'), intervalMinutes * 60_000)
      if (typeof handle.unref === 'function') handle.unref()
      ctx.effect(() => () => clearInterval(handle), 'cross-device-sync interval')
    }
  }

  // ── 卸载：清掉待执行的合并窗口 ────────────────────────────────────────────
  ctx.effect(
    () => () => {
      if (pending !== null) clearTimeout(pending)
      pending = null
    },
    'cross-device-sync teardown',
  )

  log.info?.(
    `cross-device-sync: 已挂载（device=${device} 回合收尾=${config.onTurnEnd} 会话结束=${config.onSessionEnd} 定时间隔=${intervalMinutes}min 合并窗口=${config.debounceSeconds}s）`,
  )

  // 挂载即做一次盘点，让首屏（未来的 UI 面板）有数据可读。
  try {
    const snapshot = engineStatus(home)
    writeStatus({
      reason: 'mount',
      ok: true,
      error: null,
      pulled: false,
      committed: false,
      pushed: false,
      conflicts: snapshot.conflicts.map(c => c.rel),
      integrityProblems: 0,
      pendingRemote: snapshot.missing.length,
      sessions: snapshot.sessions,
      bytes: snapshot.bytes,
      git: snapshot.git,
    })
  } catch (error) {
    log.warn?.(`cross-device-sync: 挂载盘点失败：${error}`)
  }

  const api = {
    device,
    status: () => engineStatus(home),
    sessions: () => sessionSummaries(home),
    preflight: () => preflight(home),
    repo: () => ({ isRepo: isRepo(home), hasRemote: hasRemote(home) }),
    ledger: () => writeLedger(home, device, preflight(home).sessions),
    pull: () => git(home, ['pull', '--ff-only'], { quiet: false }),
    trigger: schedule,
    /** UI 面板的「立即同步」：同步并刷新状态文件。 */
    runSync: () => {
      const result = sync(home)
      const pre = result.preflight
      writeStatus({
        reason: 'manual',
        ok: result.error === null,
        error: result.error,
        pulled: result.pulled,
        committed: result.committed,
        pushed: result.pushed,
        conflicts: pre?.conflicts?.map(c => c.rel) ?? [],
        integrityProblems: pre?.integrity?.length ?? 0,
        pendingRemote: pre?.missing?.length ?? 0,
      })
      return result
    },
  }

  // Client 半边通过这里取数。这里刻意用 ctx.inject 而不是 ctx.get：
  // ctx.get 在 apply 这一刻可能还拿不到 webServer，而那种失败是静默的（只留一行 warn），
  // 正是 v0.1.0 第一次上线时踩的坑。每进入一个阶段都覆写挂载标记，便于外部诊断。
  const marker = payload => writeMountMarker(home, {
    stage: payload.stage,
    webServer: payload.webServer,
    route: payload.route,
    device,
    pid: process.pid,
    node: process.version,
    home,
    packagePath,
  })

  marker({ stage: 'applied', webServer: false, route: null })

  ctx.inject(['webServer'], webCtx => {
    marker({ stage: 'webServer-available', webServer: true, route: null })
    return webCtx.effect(() => {
      const dispose = registerRoutes(webCtx.webServer, api)
      marker({ stage: 'routes-registered', webServer: true, route: '/cross-device-sync' })
      log.info?.('cross-device-sync: HTTP 路由已挂载（/cross-device-sync/status|sessions|run）')
      return dispose
    }, 'cross-device-sync: http routes')
  })

  return api
}
