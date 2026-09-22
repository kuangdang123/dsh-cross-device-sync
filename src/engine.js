/**
 * 同步引擎：与 CLI、Host 插件共用同一份实现。
 *
 * 三个前提（来自 DSH 实现，详见仓库 README）：
 *   - 会话日志是 append-only 的 zstd 分帧文件，一个会话一个文件，本机单写者；
 *   - resume 使用日志里记录的 cwd 且不做校验，所以路径靠 devices.yaml 对齐；
 *   - 顺序使用下没有跨机并发写，真正的风险是「未同步窗口」——由台账检出。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'

export const LOG_RE = /^session(\.v\d+)?\.jsonl(\.zstd)?$/
const MAGIC = Object.freeze([0x28, 0xb5, 0x2f, 0xfd])

export function resolveHome(env = process.env) {
  return env.DSH_HOME ?? join(homedir(), '.dsh')
}

// ── 挂载标记：让「Host 半边到底有没有跑起来」可被外部检查 ────────────────────
/**
 * Host 半边每次进入一个阶段就覆写一次标记。这一步存在的唯一理由是可诊断性：
 * 插件行没挂载、webServer 迟迟不出现、apply 抛错，这三种情况从外面都表现为
 * 「面板没数据」，而标记能直接区分它们。
 * @param home - DSH_HOME
 * @param payload - 阶段信息（stage/route/webServer/pid…）
 * @returns 标记文件路径；写不进去时返回 undefined
 */
export function writeMountMarker(home, payload) {
  try {
    mkdirSync(join(home, '.dsh-sync'), { recursive: true })
    const file = join(home, '.dsh-sync', 'host-mount.json')
    writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...payload }, null, 2))
    return file
  } catch {
    // 标记只是诊断产物：磁盘只读或权限不足时不该让插件本身起不来。
    return undefined
  }
}

/** 读挂载标记；不存在返回 undefined（＝ 这个 HOME 里 Host 半边从未 apply）。 */
export function readMountMarker(home) {
  const file = join(home, '.dsh-sync', 'host-mount.json')
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { at: null, stage: 'unreadable' }
  }
}

// ── 设备身份 ────────────────────────────────────────────────────────────────
export function deviceId(home, { create = false } = {}) {
  const file = join(home, '.device-id')
  if (existsSync(file)) return readFileSync(file, 'utf8').trim()
  if (!create) throw new Error(`缺少 ${file}；先运行 dsh-sync init`)
  const id = randomUUID()
  writeFileSync(file, `${id}\n`, { encoding: 'utf8', mode: 0o600 })
  return id
}

// ── 会话文件 ────────────────────────────────────────────────────────────────
/**
 * 归档会话：读取 `storages/workspace.json` 的 `global.archivedSessionIds`。
 * 规则：归档的东西不参与同步（不进台账、不进面板列表），可以用 `prune` 从本地删掉。
 * @param home - DSH_HOME
 * @returns 归档会话 id 的集合（与 sessions/ 下的目录名同形）
 */
export function archivedSessionIds(home) {
  const file = join(home, 'storages', 'workspace.json')
  if (!existsSync(file)) return new Set()
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    const ids = data?.global?.archivedSessionIds
    return new Set(Array.isArray(ids) ? ids.map(String) : [])
  } catch {
    // 工作区清单损坏时按"没有归档"处理：宁可多同步，不可误删。
    return new Set()
  }
}

/**
 * 遍历本地会话日志。
 * @param home - DSH_HOME
 * @param options.includeArchived - 默认 false：归档会话被排除在同步与列表之外
 */
export function walkSessions(home, { includeArchived = false } = {}) {
  const root = join(home, 'sessions')
  const out = []
  if (!existsSync(root)) return out
  const archived = includeArchived ? new Set() : archivedSessionIds(home)
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectDir = join(root, project.name)
    for (const session of readdirSync(projectDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      if (archived.has(session.name)) continue
      const dir = join(projectDir, session.name)
      const logs = readdirSync(dir).filter(n => LOG_RE.test(n)).sort()
      if (logs.length === 0) continue
      out.push({
        id: session.name,
        project: project.name,
        dir,
        logs: logs.map(name => {
          const abs = join(dir, name)
          const st = statSync(abs)
          return { name, abs, rel: relative(home, abs).split(sep).join('/'), bytes: st.size, mtimeMs: Math.round(st.mtimeMs) }
        }),
        generations: logs.map(n => n.replace(/^session\.?/, '').replace(/\.jsonl(\.zstd)?$/, '') || 'v0'),
        encodings: [...new Set(logs.map(n => (n.endsWith('.zstd') ? 'zstd' : 'plain')))],
      })
    }
  }
  return out
}

// ── 分帧读取与校验 ──────────────────────────────────────────────────────────
function frameOffsets(buf) {
  const offs = []
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) offs.push(i)
  }
  return offs
}

function readSlice(abs, from, length) {
  const fd = openSync(abs, 'r')
  try {
    const size = statSync(abs).size
    const start = from === 'end' ? Math.max(0, size - length) : from
    const len = Math.min(length, size - start)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, start)
    return buf
  } finally {
    closeSync(fd)
  }
}

function decodeAt(buf, offset) {
  try {
    return zstdDecompressSync(buf.subarray(offset)).toString('utf8')
  } catch {
    return undefined
  }
}

/**
 * 取最后一个帧并解压。单帧可能远大于 1MB（一次 append 批次可以很大），
 * 所以尾部窗口逐级放大，最后回退整文件扫描——否则会把正常文件误报成被截断。
 */
export function lastFrameText(abs) {
  for (const window of [1024 * 1024, 8 * 1024 * 1024]) {
    const slice = readSlice(abs, 'end', window)
    const offs = frameOffsets(slice)
    if (offs.length === 0) continue
    const text = decodeAt(slice, offs[offs.length - 1])
    if (text !== undefined) return { text, frames: offs.length }
  }
  const whole = readFileSync(abs)
  const offs = frameOffsets(whole)
  if (offs.length === 0) return { text: undefined, frames: 0 }
  return { text: decodeAt(whole, offs[offs.length - 1]), frames: offs.length }
}

/** 校验一个会话目录：首帧必须是 session 头，末帧必须可解，编码不得混用。 */
export function verifySession(session, { full = false } = {}) {
  const problems = []
  const facts = []
  for (const log of session.logs) {
    if (!log.name.endsWith('.zstd')) {
      facts.push(`${log.name}: 未压缩（plain）`)
      continue
    }
    const head = readSlice(log.abs, 0, 1024 * 1024)
    if (frameOffsets(head)[0] !== 0) {
      problems.push(`${log.name}: 首字节不是 zstd 帧头（文件损坏或编码不符）`)
      continue
    }
    const headText = decodeAt(head, 0)
    if (headText === undefined) {
      problems.push(`${log.name}: 首帧无法解压`)
      continue
    }
    const firstLine = headText.split('\n').find(l => l.trim().length > 0) ?? ''
    let header
    try {
      header = JSON.parse(firstLine)
    } catch {
      problems.push(`${log.name}: 首帧不是合法 JSON`)
      continue
    }
    if (header.type !== 'session') problems.push(`${log.name}: 首帧不是 session 头（type=${header.type}）`)

    const tail = lastFrameText(log.abs)
    if (tail.text === undefined) {
      problems.push(`${log.name}: 末帧无法解压（同步中断或被截断，或找不到帧头）`)
    } else if (full) {
      const whole = readFileSync(log.abs)
      const offs = frameOffsets(whole)
      let bad = 0
      for (const off of offs) if (decodeAt(whole, off) === undefined) bad++
      if (bad > 0) problems.push(`${log.name}: ${bad}/${offs.length} 帧解压失败`)
      facts.push(`${log.name}: ${offs.length} 帧全部通过`)
    }
    if (header?.cwd !== undefined) facts.push(`${log.name}: cwd=${header.cwd}`)
  }
  if (session.encodings.length > 1) {
    problems.push(`同一会话目录混合编码（${session.encodings.join(' + ')}）—— 一个 root 只允许一种编码`)
  }
  if (session.generations.length > 1) {
    facts.push(`多代共存：${session.generations.join(', ')}（升级后正常，但别把旧代同步回新代设备）`)
  }
  return { problems, facts }
}

export function verifyAll(home, { full = false } = {}) {
  const sessions = walkSessions(home)
  const results = sessions.map(s => ({ project: s.project, id: s.id, ...verifySession(s, { full }) }))
  return { total: sessions.length, failed: results.filter(r => r.problems.length > 0).length, results }
}

/**
 * 每个会话日志一行的摘要，供 UI 面板列出「本地可见的全部会话」。
 * 只解首帧（session 头）拿 cwd / createdAt / preset，不解全文件。
 * device 来自台账：写明这个文件最近由哪台设备改动过。
 */
export function sessionSummaries(home) {
  const me = deviceId(home)
  const ledgers = allLedgers(home)
  const owner = new Map()
  for (const ledger of ledgers) {
    for (const rel of Object.keys(ledger.files ?? {})) owner.set(rel, ledger.device)
  }
  const rows = []
  for (const session of walkSessions(home)) {
    for (const log of session.logs) {
      let header
      try {
        const text = decodeAt(readSlice(log.abs, 0, 1024 * 1024), 0)
        header = text === undefined ? undefined : JSON.parse(text.split('\n').find(l => l.trim().length > 0) ?? '{}')
      } catch {
        header = undefined
      }
      rows.push({
        rel: log.rel,
        project: session.project,
        id: session.id,
        generation: log.name,
        bytes: log.bytes,
        mtimeMs: log.mtimeMs,
        cwd: header?.cwd ?? null,
        createdAt: header?.createdAt ?? null,
        preset: header?.agentPreset ?? null,
        // 没有台账归属的文件一定是本机产物（拉来的会话会被对方台账标上设备），
        // 默认记为本机——否则面板按设备筛选时会把自己刚写的东西全滤掉。
        device: owner.get(log.rel) ?? me,
      })
    }
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return { sessions: rows }
}

// ── 同步台账 ────────────────────────────────────────────────────────────────
const ledgerDir = home => join(home, '.dsh-sync')
const ledgerPath = (home, id) => join(ledgerDir(home), `ledger-${id}.json`)

export function readLedger(home, id) {
  const p = ledgerPath(home, id)
  if (!existsSync(p)) return { device: id, updatedAt: null, files: {} }
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return { device: id, updatedAt: null, files: {} }
  }
}

export function allLedgers(home) {
  const dir = ledgerDir(home)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(n => /^ledger-.+\.json$/.test(n))
    .map(n => {
      try {
        return JSON.parse(readFileSync(join(dir, n), 'utf8'))
      } catch {
        return undefined
      }
    })
    .filter(Boolean)
}

export function writeLedger(home, id, sessions) {
  const files = {}
  for (const s of sessions) for (const l of s.logs) files[l.rel] = { bytes: l.bytes, mtimeMs: l.mtimeMs }
  mkdirSync(ledgerDir(home), { recursive: true })
  const path = ledgerPath(home, id)
  writeFileSync(path, JSON.stringify({ device: id, updatedAt: new Date().toISOString(), files }, null, 2))
  return path
}

const same = (a, b) => a !== undefined && b !== undefined && a.bytes === b.bytes && a.mtimeMs === b.mtimeMs

/** 三方比较：我的旧台账 / 本地现状 / 其他设备台账。 */
export function classify(home, sessions, me) {
  const mine = readLedger(home, me).files
  const others = allLedgers(home).filter(l => l.device !== me)
  const rows = []
  for (const s of sessions) {
    for (const l of s.logs) {
      const m = mine[l.rel]
      let theirs
      for (const o of others) {
        const e = o.files?.[l.rel]
        if (e === undefined) continue
        if (theirs === undefined || e.mtimeMs > theirs.mtimeMs) theirs = { ...e, device: o.device }
      }
      const localNow = { bytes: l.bytes, mtimeMs: l.mtimeMs }
      const matchesMine = same(m, localNow)
      const matchesTheirs = same(theirs, localNow)
      let verdict
      if (m === undefined && theirs === undefined) verdict = 'new'
      else if (matchesMine && theirs === undefined) verdict = 'new'
      else if (matchesMine && same(m, theirs)) verdict = 'ok'
      else if (matchesMine) verdict = 'remote-ahead'
      else if (matchesTheirs) verdict = 'pulled'
      else if (theirs !== undefined && !same(m, theirs)) verdict = 'conflict'
      else verdict = 'local-ahead'
      rows.push({ rel: l.rel, project: s.project, id: s.id, bytes: l.bytes, verdict, mine: m, theirs })
    }
  }
  const missing = []
  for (const o of others) {
    for (const [rel, e] of Object.entries(o.files ?? {})) {
      if (!existsSync(join(home, rel.split('/').join(sep)))) missing.push({ rel, device: o.device, bytes: e.bytes })
    }
  }
  return { rows, missing }
}

// ── git ─────────────────────────────────────────────────────────────────────
export function git(home, args, { quiet = true } = {}) {
  return spawnSync('git', ['-C', home, ...args], { encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit' })
}
export const isRepo = home => git(home, ['rev-parse', '--is-inside-work-tree']).status === 0
export const hasRemote = home => git(home, ['remote', 'get-url', 'origin']).status === 0
export function unmerged(home) {
  return (git(home, ['diff', '--name-only', '--diff-filter=U']).stdout ?? '').trim().split('\n').filter(Boolean)
}

// ── 对外动作 ────────────────────────────────────────────────────────────────
/** 台账里的设备清单：UI 的「设备筛选」用它，本机永远在列（即使还没写过台账）。 */
export function devicesFromLedgers(home, me) {
  const map = new Map()
  for (const ledger of allLedgers(home)) {
    const files = Object.keys(ledger.files ?? {}).length
    const bytes = Object.values(ledger.files ?? {}).reduce((sum, f) => sum + (typeof f?.bytes === 'number' ? f.bytes : 0), 0)
    map.set(ledger.device, { device: ledger.device, files, bytes, updatedAt: ledger.updatedAt ?? null, self: ledger.device === me })
  }
  const self = walkSessions(home)
  map.set(me, {
    device: me,
    files: self.reduce((n, s) => n + s.logs.length, 0),
    bytes: self.reduce((n, s) => n + s.logs.reduce((b, l) => b + l.bytes, 0), 0),
    updatedAt: map.get(me)?.updatedAt ?? null,
    self: true,
  })
  return [...map.values()].sort((a, b) => (a.self === b.self ? String(a.device).localeCompare(String(b.device)) : a.self ? -1 : 1))
}

export function status(home) {
  const me = deviceId(home)
  const sessions = walkSessions(home)
  const { rows, missing } = classify(home, sessions, me)
  const verdicts = rows.reduce((a, r) => {
    a[r.verdict] = (a[r.verdict] ?? 0) + 1
    return a
  }, {})
  return {
    device: me,
    devices: devicesFromLedgers(home, me),
    sessions: sessions.length,
    files: rows.length,
    bytes: rows.reduce((a, r) => a + r.bytes, 0),
    verdicts,
    conflicts: rows.filter(r => r.verdict === 'conflict'),
    remoteAhead: rows.filter(r => r.verdict === 'remote-ahead'),
    missing,
    git: {
      repo: isRepo(home),
      remote: hasRemote(home),
      dirty: (git(home, ['status', '--porcelain']).stdout ?? '').trim().split('\n').filter(Boolean).length,
      unmerged: unmerged(home),
    },
  }
}

/** GitHub 的单文件硬上限是 100 MB；留出余量，超了就拒绝提交而不是让 push 失败。 */
export const MAX_SESSION_FILE_BYTES = 90 * 1024 * 1024
/** 仓库体积预警线：超过就提示压缩历史（GitHub 对 >1GB 的仓库会警告并变慢）。 */
export const MAX_REPO_BYTES = 800 * 1024 * 1024

/** 完整性 + 冲突 + 体积闸门；任一不过就抛错，绝不自动合并。 */
export function preflight(home, { me } = {}) {
  const device = me ?? deviceId(home)
  const sessions = walkSessions(home)
  const integrity = []
  let totalBytes = 0
  const oversize = []
  for (const s of sessions) {
    const { problems } = verifySession(s)
    if (problems.length > 0) integrity.push({ id: s.id, project: s.project, problems })
    for (const log of s.logs) {
      totalBytes += log.bytes
      if (log.bytes > MAX_SESSION_FILE_BYTES) oversize.push({ rel: log.rel, bytes: log.bytes })
    }
  }
  const { rows, missing } = classify(home, sessions, device)
  const conflicts = rows.filter(r => r.verdict === 'conflict')
  return { device, sessions, integrity, conflicts, missing, oversize, totalBytes }
}

/** 一次同步：拉配置 → 校验 → 记台账 → 提交推送。任一步失败即停。 */
export function sync(home, { commit = true, push = true } = {}) {
  const result = { pulled: false, pushed: false, committed: false, preflight: null, error: null }
  try {
    const pre = preflight(home)
    result.preflight = pre
    if (pre.integrity.length > 0) throw new Error(`${pre.integrity.length} 个会话日志未通过完整性校验`)
    if (pre.conflicts.length > 0) throw new Error(`${pre.conflicts.length} 个会话两端都改过，拒绝自动继续`)
    if (pre.oversize.length > 0) {
      throw new Error(`${pre.oversize.length} 个会话文件超过 90 MB（GitHub 单文件上限 100 MB）：${pre.oversize[0].rel}`)
    }
    if (!isRepo(home)) throw new Error('配置目录不是 git 仓库')
    const pull = git(home, ['pull', '--ff-only'], { quiet: false })
    if (pull.status !== 0) throw new Error('git pull 失败（可能有分叉）——不要 force，先人工处理')
    result.pulled = true
    writeLedger(home, pre.device, pre.sessions)
    if (!commit) return result
    git(home, ['add', '-A'])
    const message = `sync(${pre.device.slice(0, 8)}): ${new Date().toISOString()}`
    const c = git(home, ['commit', '-m', message])
    if (c.status !== 0 && !/nothing to commit/.test(`${c.stdout}${c.stderr}`)) throw new Error('git commit 失败')
    result.committed = true
    if (!push) return result
    if (!hasRemote(home)) return result
    const p = git(home, ['push'], { quiet: false })
    if (p.status !== 0) throw new Error('git push 失败 —— 先 pull 再重试，禁止 force')
    result.pushed = true
    return result
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
    return result
  }
}

/**
 * 把一份会话日志投影成面板可读的只读转写。
 * 只读：不写回原文件，也不改任何状态——跨设备看历史不该有副作用。
 * @param home - DSH_HOME
 * @param rel - 会话日志相对路径，必须是 walkSessions 列出的文件（白名单校验，杜绝路径穿越）
 * @param options.messageLimit - 保留最后多少条消息
 * @param options.textLimit - 单条消息截断长度
 */
export function sessionTranscript(home, rel, { messageLimit = 200, textLimit = 4000 } = {}) {
  const target = walkSessions(home).flatMap(s => s.logs).find(l => l.rel === rel)
  if (target === undefined) return { ok: false, error: '该会话不在本地可见集合里' }

  let text
  if (target.name.endsWith('.zstd')) {
    const buf = readFileSync(target.abs)
    const parts = []
    let bad = 0
    for (const off of frameOffsets(buf)) {
      const decoded = decodeAt(buf, off)
      if (decoded === undefined) bad += 1
      else parts.push(decoded)
    }
    if (bad > 0) return { ok: false, error: `${bad} 帧解压失败，拒绝渲染不完整的会话` }
    text = parts.join('')
  } else {
    text = readFileSync(target.abs, 'utf8')
  }

  const events = []
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // 分帧日志理论上每行都是完整 JSON；容忍半行（截断尾部）而不放弃整份记录。
    }
  }

  const clip = value => {
    const str = String(value ?? '')
    return str.length > textLimit ? `${str.slice(0, textLimit)}…（已截断）` : str
  }
  const textOf = content => (Array.isArray(content) ? content.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '')
  const header = events.find(e => e.type === 'session')
  const messages = []
  for (const event of events) {
    const data = event.data ?? {}
    if (event.type === 'user/message') {
      const body = textOf(data.content)
      if (body.trim().length === 0) continue
      messages.push({ seq: event.seq, role: data.source?.kind === 'user' ? 'user' : 'context', text: clip(body) })
    } else if (event.type === 'assistant/message') {
      const body = textOf(data.message?.content)
      if (body.trim().length === 0) continue
      messages.push({ seq: event.seq, role: 'assistant', text: clip(body) })
    } else if (event.type === 'tool/call') {
      messages.push({ seq: event.seq, role: 'tool-call', text: clip(`${data.name}(${data.arguments ?? ''})`) })
    } else if (event.type === 'tool/result') {
      messages.push({ seq: event.seq, role: 'tool-result', text: clip(textOf(data.message?.content) || '(空结果)') })
    }
  }

  const truncated = messages.length > messageLimit
  return {
    ok: true,
    rel,
    sessionId: header?.id ?? null,
    cwd: header?.cwd ?? null,
    createdAt: header?.createdAt ?? null,
    preset: header?.agentPreset ?? null,
    bytes: target.bytes,
    messageCount: messages.length,
    truncated,
    messages: truncated ? messages.slice(-messageLimit) : messages,
  }
}

/**
 * 删除本地已归档的会话目录。归档不参与同步，所以删掉它们不影响任何设备的台账。
 * 默认只列不删（护栏：先看清单，再 --apply）。
 */
export function pruneArchived(home, { apply = false } = {}) {
  const archived = archivedSessionIds(home)
  const root = join(home, 'sessions')
  const targets = []
  if (existsSync(root)) {
    for (const project of readdirSync(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue
      const projectDir = join(root, project.name)
      for (const session of readdirSync(projectDir, { withFileTypes: true })) {
        if (!session.isDirectory() || !archived.has(session.name)) continue
        const dir = join(projectDir, session.name)
        const files = readdirSync(dir)
        const bytes = files.reduce((sum, f) => sum + statSync(join(dir, f)).size, 0)
        targets.push({ dir, project: project.name, id: session.name, files: files.length, bytes })
      }
    }
  }
  if (apply) for (const target of targets) rmSync(target.dir, { recursive: true, force: true })
  return { archived: archived.size, targets, applied: apply }
}

/** 初始化：生成设备身份与同步目录。 */
export function init(home) {
  const existed = existsSync(join(home, '.device-id'))
  const id = deviceId(home, { create: true })
  mkdirSync(ledgerDir(home), { recursive: true })
  mkdirSync(join(home, 'sessions'), { recursive: true })
  return { id, created: !existed, home, ledgerDir: ledgerDir(home), repo: isRepo(home) }
}
