#!/usr/bin/env node
/**
 * 命令行入口：与 Host 插件共用 src/engine.js，所以两者行为一致。
 *
 *   dsh-sync init              生成设备身份与同步目录（每台设备一次）
 *   dsh-sync status            盘点会话、台账、冲突、git 状态
 *   dsh-sync verify [--full]   校验日志完整性（首/尾帧；--full 逐帧）
 *   dsh-sync pull              预检 → git pull --ff-only → 更新台账
 *   dsh-sync push              预检 → 更新台账 → add/commit/push
 *   dsh-sync sync              pull + push
 *   dsh-sync diagnose          排查「面板没数据」：挂载标记 / profile 注册 / 客户端产物 / 上次同步
 *
 * 退出码：0 正常 · 2 冲突 · 3 git 问题 · 4 完整性问题
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { classify, deviceId, git, hasRemote, init, isRepo, preflight, readMountMarker, resolveHome, status, sync, verifyAll, walkSessions, writeLedger } from '../src/engine.js'

const HOME = resolveHome()
const argv = process.argv.slice(2)
const cmd = argv.find(a => !a.startsWith('-')) ?? 'status'
const dryRun = argv.includes('--dry-run')
const full = argv.includes('--full')

const paint = {
  dim: s => `\u001b[2m${s}\u001b[0m`,
  red: s => `\u001b[31m${s}\u001b[0m`,
  yel: s => `\u001b[33m${s}\u001b[0m`,
  grn: s => `\u001b[32m${s}\u001b[0m`,
  b: s => `\u001b[1m${s}\u001b[0m`,
}
const say = (...a) => console.log(...a)
const die = (code, msg) => {
  say(paint.red(msg))
  process.exit(code)
}
const mb = n => `${(n / 1048576).toFixed(1)} MB`

function cmdInit() {
  const r = init(HOME)
  say(`${r.created ? '已生成' : '已存在'}设备身份：${paint.b(r.id)}`)
  say(paint.dim(`  设备文件：${HOME}\\.device-id（不要同步、不要提交）`))
  say(paint.dim(`  台账目录：${r.ledgerDir}`))
  say('\n把 id 填进 devices.yaml 的 devices.<名字>，并在另一台设备重复 init。')
  if (!r.repo) {
    say('\n本目录还不是 git 仓库，启用配置同步：')
    say(`  git -C "${HOME}" init -b main`)
    say(`  git -C "${HOME}" add -A && git -C "${HOME}" commit -m "dsh config"`)
    say(`  git -C "${HOME}" remote add origin <你的私有仓库>`)
    say(`  git -C "${HOME}" push -u origin main`)
  }
}

function cmdStatus() {
  const s = status(HOME)
  say(`${paint.b('设备')} ${s.device}`)
  say(`${paint.b('会话')} ${s.sessions} 个目录 / ${s.files} 个日志文件 / ${mb(s.bytes)}`)
  say(`${paint.b('台账')} ${Object.entries(s.verdicts).map(([k, v]) => `${k}=${v}`).join('  ') || '(空)'}`)
  if (s.conflicts.length > 0) {
    say(`\n${paint.red('冲突（两端都改过，脚本不会自动合并）：')}`)
    for (const c of s.conflicts) {
      say(`  ${c.rel}\n    本地 ${c.bytes}B · 本机台账 ${c.mine?.bytes ?? '-'}B · 远端(${c.theirs?.device ?? '?'}) ${c.theirs?.bytes ?? '-'}B`)
    }
  }
  if (s.remoteAhead.length > 0) {
    const ids = s.remoteAhead.map(r => r.id)
    say(`\n${paint.yel('远端更新（先 pull 再继续这些会话）：')} ${ids.slice(0, 8).join(', ')}${ids.length > 8 ? ` … +${ids.length - 8}` : ''}`)
  }
  if (s.missing.length > 0) say(`\n${paint.yel('台账里有、本地还没有（同步未送达）：')} ${s.missing.length} 个文件`)
  if (s.git.repo) {
    say(`\n${paint.b('git')} 仓库就绪；未提交变更 ${s.git.dirty} 项；origin ${s.git.remote ? '已配置' : paint.yel('未配置')}`)
    if (s.git.unmerged.length > 0) say(paint.red(`  未解决的合并冲突：${s.git.unmerged.join(', ')}`))
  } else {
    say(`\n${paint.b('git')} ${paint.yel('未初始化')}（见 init 输出）`)
  }
  process.exit(s.conflicts.length > 0 ? 2 : 0)
}

function cmdVerify() {
  const r = verifyAll(HOME, { full })
  for (const row of r.results) {
    if (row.problems.length === 0) {
      if (full) {
        say(`${paint.grn('✓')} ${row.project}/${row.id}`)
        for (const f of row.facts) say(paint.dim(`    ${f}`))
      }
      continue
    }
    say(`${paint.red('✗')} ${row.project}/${row.id}`)
    for (const p of row.problems) say(`    ${p}`)
  }
  say(`\n校验完成：${r.total} 个会话目录，${r.failed} 个有问题${full ? '（全帧模式）' : '（首/尾帧模式）'}`)
  process.exit(r.failed > 0 ? 4 : 0)
}

function gate() {
  const pre = preflight(HOME)
  if (pre.integrity.length > 0) {
    for (const row of pre.integrity.slice(0, 5)) say(paint.red(`✗ ${row.project}/${row.id}: ${row.problems[0]}`))
    die(4, `\n${pre.integrity.length} 个会话日志未通过完整性校验 —— 先修好再同步。`)
  }
  if (pre.conflicts.length > 0 && !dryRun) {
    die(2, `\n${pre.conflicts.length} 个会话两端都改过，拒绝自动继续：\n  ${pre.conflicts.map(c => c.rel).join('\n  ')}\n人工取舍后再跑。`)
  }
  return pre
}

function cmdPull() {
  const pre = gate()
  if (!isRepo(HOME)) die(3, '配置目录不是 git 仓库；见 init 输出。')
  if (dryRun) {
    say(paint.dim('[dry-run] git pull --ff-only'))
    return
  }
  const r = git(HOME, ['pull', '--ff-only'], { quiet: false })
  if (r.status !== 0) die(3, 'git pull 失败（可能有分叉）——不要 force，先人工处理。')
  writeLedger(HOME, pre.device, pre.sessions)
  say(paint.grn(`pull 完成；台账已更新（设备 ${pre.device}）`))
}

function cmdPush() {
  const pre = gate()
  if (!isRepo(HOME)) die(3, '配置目录不是 git 仓库；见 init 输出。')
  writeLedger(HOME, pre.device, pre.sessions)
  if (dryRun) {
    say(paint.dim('[dry-run] git add -A && git commit && git push'))
    return
  }
  git(HOME, ['add', '-A'])
  const c = git(HOME, ['commit', '-m', `sync(${pre.device.slice(0, 8)}): ${new Date().toISOString()}`])
  if (c.status !== 0 && !/nothing to commit/.test(`${c.stdout}${c.stderr}`)) die(3, 'git commit 失败')
  if (!hasRemote(HOME)) {
    say(paint.yel('未配置 origin，已本地提交但未推送。'))
    return
  }
  const p = git(HOME, ['push'], { quiet: false })
  if (p.status !== 0) die(3, 'git push 失败 —— 先 pull 再重试，禁止 force。')
  say(paint.grn(`push 完成（设备 ${pre.device}）`))
}

/**
 * diagnose：把「为什么面板没数据」拆成可判定的几条。
 * 只读磁盘，不连服务、不改状态。
 */
function cmdDiagnose() {
  const profile = join(HOME, 'profiles', 'web')
  const manifestPath = join(profile, 'package.json')
  const clientArtifact = join(profile, 'node_modules', 'dsh-cross-device-sync', 'lib', 'client.js')

  say(paint.b('=== 环境 ==='))
  say(`DSH_HOME            ${HOME}`)
  let device = '(未初始化，先跑 init)'
  try {
    device = deviceId(HOME)
  } catch {
    // 还没 init 是正常状态，如实显示即可。
  }
  say(`设备身份            ${device}`)
  say(`profile 目录        ${profile}`)

  say('')
  say(paint.b('=== Host 半边（插件行）==='))
  const marker = readMountMarker(HOME)
  if (marker === undefined) {
    say(paint.yel('挂载标记            不存在 → Host 半边从未在这个 DSH_HOME 里 apply'))
    say(paint.dim('  面板会显示「Host 半边未挂载」。先确认插件行在组合树里，再重启 profile。'))
  } else {
    say(`挂载标记            ${join(HOME, '.dsh-sync', 'host-mount.json')}`)
    say(`  stage             ${marker.stage === 'routes-registered' ? paint.grn(String(marker.stage)) : paint.yel(String(marker.stage))}`)
    say(`  at / pid / node   ${marker.at ?? '-'} / ${marker.pid ?? '-'} / ${marker.node ?? '-'}`)
    say(`  代码位置           ${marker.packagePath ?? '-'}`)
    if (marker.route !== undefined && marker.route !== null) say(`  route             ${marker.route}`)
    if (marker.stage === 'applied') say(paint.yel('  → 已 apply 但 webServer 始终没出现，路由未注册'))
    if (marker.stage === 'webServer-available') say(paint.yel('  → webServer 已就绪但 effect 还没跑完'))
  }

  say('')
  say(paint.b('=== profile 注册状态 ==='))
  if (!existsSync(manifestPath)) {
    say(paint.yel(`找不到 ${manifestPath}`))
  } else {
    let manifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (error) {
      manifest = undefined
      say(paint.red(`profile package.json 解析失败：${error}`))
    }
    if (manifest !== undefined) {
      const dep = manifest.dependencies?.['dsh-cross-device-sync'] ?? '(不在 dependencies)'
      const bundles = manifest.dsh?.profile?.bundles ?? []
      const inBundles = bundles.includes('dsh-cross-device-sync')
      say(`依赖                ${dep}`)
      say(`bundles 列表        ${inBundles ? paint.grn('含 dsh-cross-device-sync') : paint.red('不含 → 插件行不会进插件树')}`)
    }
  }
  if (existsSync(clientArtifact)) {
    const st = statSync(clientArtifact)
    say(`客户端产物          ${clientArtifact}`)
    say(`                    ${st.size} B，${new Date(st.mtimeMs).toLocaleString()}`)
  } else {
    say(paint.yel(`客户端产物不存在：${clientArtifact}（先跑 node build/build-client.mjs）`))
  }

  say('')
  say(paint.b('=== 最近一次同步 ==='))
  const statusFile = join(HOME, '.dsh-sync', 'status.json')
  if (existsSync(statusFile)) {
    try {
      const s = JSON.parse(readFileSync(statusFile, 'utf8'))
      say(`status.json         ok=${s.ok} reason=${s.reason} at=${s.at}`)
      if (s.error) say(paint.yel(`  上次错误          ${s.error}`))
    } catch (error) {
      say(paint.yel(`status.json 读不动：${error}`))
    }
  } else {
    say(paint.dim('status.json         不存在（Host 半边还没挂载过，或还没触发同步）'))
  }
  const ledgers = existsSync(join(HOME, '.dsh-sync')) ? readdirSync(join(HOME, '.dsh-sync')).filter(n => n.startsWith('ledger-')) : []
  say(`台账文件            ${ledgers.length === 0 ? '(无)' : ledgers.join(', ')}`)
}

function cmdSync() {
  if (dryRun) {
    cmdPull()
    cmdPush()
    return
  }
  const pre = gate()
  const result = sync(HOME)
  if (result.error !== null) die(result.preflight?.conflicts?.length ? 2 : 3, `同步失败：${result.error}`)
  say(paint.grn(`同步完成 pull=${result.pulled} commit=${result.committed} push=${result.pushed}（设备 ${pre.device}）`))
}

const cmds = { init: cmdInit, status: cmdStatus, verify: cmdVerify, pull: cmdPull, push: cmdPush, sync: cmdSync, diagnose: cmdDiagnose }
if (!(cmd in cmds)) die(1, `未知子命令：${cmd}\n可用：${Object.keys(cmds).join(', ')}`)
say(paint.dim(`DSH_HOME=${HOME}${dryRun ? '  [dry-run]' : ''}`))
cmds[cmd]()

// 未使用的导入保持显式，避免与引擎漂移
void classify
void deviceId
void walkSessions
