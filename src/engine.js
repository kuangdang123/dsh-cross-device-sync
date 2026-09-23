/**
 * 同步引擎：与 CLI、Host 插件共用同一份实现。
 *
 * 三个前提（来自 DSH 实现，详见仓库 README）：
 *   - 会话日志是 append-only 的 zstd 分帧文件，一个会话一个文件，本机单写者；
 *   - resume 使用日志里记录的 cwd 且不做校验，所以路径靠 devices.yaml 对齐；
 *   - 顺序使用下没有跨机并发写，真正的风险是「未同步窗口」——由台账检出。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, renameSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join, relative, sep, dirname } from 'node:path'
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
  const attribution = gitAttribution(home)
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
        // 归属优先级：git 提交作者（随仓库旅行、最可信）→ 本机台账 → 本机。
        // 拉来的会话若没有 git 归属，才会落到"本机"这个兜底上。
        device: attribution.get(log.rel)?.device ?? owner.get(log.rel) ?? me,
        updatedAt: attribution.get(log.rel)?.at ?? log.mtimeMs,
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

/**
 * 活跃会话的提交冷却（分钟）。
 * 会话日志是 zstd 二进制，git 无法跨版本 delta；而活跃会话每个回合都在增长，
 * 每同步一次就整份存一层新副本（实测平均每次同步 14.8 MB，最贵的那个文件被重写 6 次）。
 * 让"最近 N 分钟内改动过"的会话在这一轮不提交，等它凉下来再进历史。
 */
export const DEFAULT_COMMIT_COOLDOWN_MINUTES = 10

/** 把仍在冷却期内的会话从索引里撤下（它们还会继续增长）。返回被延后的路径。 */
function unstageHotSessions(home, sessions, cooldownMinutes) {
  if (!(cooldownMinutes > 0)) return []
  const cutoff = Date.now() - cooldownMinutes * 60_000
  const hot = sessions.flatMap(s => s.logs).filter(l => l.mtimeMs >= cutoff).map(l => l.rel)
  if (hot.length === 0) return []
  // 分批 reset，避免命令行长度上限。
  for (let i = 0; i < hot.length; i += 100) {
    git(home, ['reset', '-q', '--', ...hot.slice(i, i + 100)])
  }
  return hot
}

/**
 * 从 git 历史读出每个文件"最后是谁、什么时候改的"。
 *
 * 为什么用它而不是台账：台账在 `.dsh-sync/` 里、被 .gitignore 排除，**不随仓库旅行**——
 * 于是别的设备拉过去的会话在本机全被误判成"本机"。而 git 提交本身就带作者与时间，
 * 一次 `git log --name-only` 就能拿到全部归属，且随仓库天然同步。
 *
 * 作者名约定 `dsh-<设备短 id>`（由 sync 写入仓库本地 user.name）。
 * @param home - DSH_HOME（须是 git 仓库）
 * @returns Map<相对路径, { device, at }>；非 git 仓库返回空 Map
 */
export function gitAttribution(home) {
  const out = new Map()
  if (!isRepo(home)) return out
  const r = git(home, ['log', '--date=unix', '--pretty=format:\u0001%an\u0001%at', '--name-only', '--', 'sessions'])
  if (r.status !== 0) return out
  let device = null
  let at = null
  for (const line of (r.stdout ?? '').split('\n')) {
    if (line.startsWith('\u0001')) {
      const [, author, stamp] = line.split('\u0001')
      device = author !== undefined && author.startsWith('dsh-') ? author.slice(4) : (author ?? null)
      at = stamp !== undefined ? Number(stamp) * 1000 : null
      continue
    }
    const path = line.trim()
    if (path.length === 0 || device === null) continue
    // 新→旧遍历，先出现的即"最后一次改动"
    if (!out.has(path)) out.set(path, { device, at })
  }
  return out
}

/** 把本机设备身份写进仓库本地 git 身份，使提交自带归属。幂等。 */
export function ensureAttributionIdentity(home, device) {
  if (!isRepo(home)) return { changed: false }
  const name = `dsh-${device.slice(0, 8)}`
  const email = `${device.slice(0, 8)}@dsh.local`
  const current = (git(home, ['config', '--local', 'user.name'], { quiet: true }).stdout ?? '').trim()
  if (current === name) return { changed: false, name }
  git(home, ['config', '--local', 'user.name', name])
  git(home, ['config', '--local', 'user.email', email])
  return { changed: true, name }
}

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

// ── 「绝不同步」闸门 ─────────────────────────────────────────────────────────
/**
 * 本机身份与凭据：绝不进任何 git 通道。
 * 只写 .gitignore 不够——用户手改一次 ignore 就破防，所以还要一道查索引的硬闸门。
 */
export const NEVER_SYNC_SENSITIVE = Object.freeze([
  '.credentials.yaml',
  '.device-id',
  '.anonymous-user-id',
])

/** 机器本地或体积过大：不随 git 走（每台设备自己生成 / 重装）。 */
export const NEVER_SYNC_LOCAL = Object.freeze([
  'profiles/',
  'electron/',
  'cache/',
  'logs/',
  'tools/',
  'dsh-pet/',
  'storages/',
  '.dsh-sync/status.json',
  '.dsh-sync/host-mount.json',
  '.dsh-sync/trash/',
])

/**
 * 命中「绝不同步」的入库路径：已跟踪的（ls-files）与会被 `add -A` 捕获的（status）。
 * 后者包含「未跟踪且未被 ignore」——那正是 `git add -A` 会吃进去的集合。
 * @param home - DSH_HOME
 * @returns 相对 HOME 的路径，已排序
 */
export function escapedNeverSyncPaths(home) {
  if (!isRepo(home)) return []
  const patterns = [...NEVER_SYNC_SENSITIVE, ...NEVER_SYNC_LOCAL]
  const matches = name => patterns.some(p => (p.endsWith('/') ? name.startsWith(p) : name === p))
  const found = new Set()
  for (const line of (git(home, ['ls-files']).stdout ?? '').split('\n')) {
    const name = line.trim()
    if (name.length > 0 && matches(name)) found.add(name)
  }
  // porcelain 第 3 列起是路径；重命名条目是 `old -> new`，两侧都要判。
  for (const line of (git(home, ['status', '--porcelain', '-uall']).stdout ?? '').split('\n')) {
    if (line.trim().length === 0) continue
    for (const candidate of line.slice(3).trim().split(' -> ')) {
      const name = candidate.trim()
      if (name.length > 0 && matches(name)) found.add(name)
    }
  }
  return [...found].sort()
}

/**
 * 写好受管 ignore 后确认「绝不同步」的路径不会进 git；命中即抛错（失败要响）。
 * @param home - DSH_HOME
 * @returns 受管 ignore 的写入结果
 * @throws {Error} 当敏感/机器本地路径已被跟踪，或仍会被 `git add -A` 捕获
 */
export function guardNeverSync(home) {
  const ignored = syncManagedIgnores(home)
  const escaped = escapedNeverSyncPaths(home)
  if (escaped.length > 0) {
    throw new Error(
      `这些路径绝不该进 git，但已被跟踪或仍会被 git add -A 捕获：${escaped.join(', ')}。`
      + '先 `git rm --cached <路径>` 并确认 .gitignore 的受管块未被改动，再同步。',
    )
  }
  return ignored
}

// ── 对外动作 ────────────────────────────────────────────────────────────────
/**
 * 设备清单：UI 的「设备筛选」与「最后同步时间」用它。
 * 数据来源按可信度合并：git 提交作者（随仓库旅行）→ 本机台账 → 本机。
 * 本机永远在列，且计数来自真实文件（不是台账快照），否则刚写完还没同步时会显示 0。
 */
export function devicesFromLedgers(home, me) {
  const map = new Map()
  const attribution = gitAttribution(home)
  for (const ledger of allLedgers(home)) {
    const files = Object.keys(ledger.files ?? {}).length
    const bytes = Object.values(ledger.files ?? {}).reduce((sum, f) => sum + (typeof f?.bytes === 'number' ? f.bytes : 0), 0)
    map.set(ledger.device, { device: ledger.device, files, bytes, updatedAt: ledger.updatedAt ?? null, self: ledger.device === me })
  }
  for (const info of attribution.values()) {
    if (info.device === null) continue
    const entry = map.get(info.device) ?? { device: info.device, files: 0, bytes: 0, updatedAt: null, self: info.device === me }
    entry.files += 1
    if (info.at !== null && (entry.updatedAt === null || Date.parse(entry.updatedAt) < info.at)) {
      entry.updatedAt = new Date(info.at).toISOString()
    }
    map.set(info.device, entry)
  }
  const self = walkSessions(home)
  map.set(me, {
    ...(map.get(me) ?? {}),
    device: me,
    files: self.reduce((n, s) => n + s.logs.length, 0),
    bytes: self.reduce((n, s) => n + s.logs.reduce((b, l) => b + l.bytes, 0), 0),
    updatedAt: map.get(me)?.updatedAt ?? new Date().toISOString(),
    self: true,
  })
  return [...map.values()].sort((a, b) => (a.self === b.self ? String(a.device).localeCompare(String(b.device)) : a.self ? -1 : 1))
}

/** 本仓库最近一次提交（＝本机最后一次同步）：时间与提交数。 */
export function lastSyncInfo(home) {
  if (!isRepo(home)) return null
  const out = (git(home, ['log', '-1', '--date=unix', '--pretty=format:%at\u0001%an\u0001%s'], { quiet: true }).stdout ?? '').trim()
  if (out.length === 0) return null
  const [at, author, subject] = out.split('\u0001')
  return {
    at: at !== undefined ? Number(at) * 1000 : null,
    author: author !== undefined && author.startsWith('dsh-') ? author.slice(4) : (author ?? null),
    subject: subject ?? '',
  }
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
    lastSync: lastSyncInfo(home),
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
export function sync(home, { commit = true, push = true, cooldownMinutes = DEFAULT_COMMIT_COOLDOWN_MINUTES } = {}) {
  const result = { pulled: false, pushed: false, committed: false, ignored: null, identity: null, deferred: [], preflight: null, error: null }
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
    // pull 之后再改写 .gitignore：带着脏工作区 pull 会被 git 拒绝。
    // 归档会话必须进 .gitignore，否则下面的 add -A 会把它们提交进仓库。
    // guardNeverSync 会写好受管 ignore，并确认敏感/机器本地文件没有被跟踪、也不会被 add -A 捕获。
    result.ignored = guardNeverSync(home)
    writeLedger(home, pre.device, pre.sessions)
    if (!commit) return result
    // 归属靠提交作者：把本机身份写进仓库本地 git 身份（幂等、只影响本仓库）。
    result.identity = ensureAttributionIdentity(home, pre.device)
    git(home, ['add', '-A'])
    // 会话是 zstd 二进制，git 无法跨版本 delta：一个还在长的会话每同步一次就整份存一层。
    // 所以"冷却未完成"的会话这一轮不提交（取消暂存），留给后面的同步——它们还会继续变。
    result.deferred = unstageHotSessions(home, pre.sessions, cooldownMinutes)
    const message = `sync(${pre.device.slice(0, 8)}): ${new Date().toISOString()}${result.deferred.length > 0 ? ` (+${result.deferred.length} 个活跃会话延后)` : ''}`
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
 * 列出本地命中归档的会话目录（含体积），供 prune 与 .gitignore 受管区块共用。
 * @param home - DSH_HOME
 * @returns 归档会话目录，rel 为相对 HOME 的路径
 */
export function archivedSessionDirs(home) {
  const archived = archivedSessionIds(home)
  const root = join(home, 'sessions')
  const out = []
  if (!existsSync(root)) return out
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectDir = join(root, project.name)
    for (const session of readdirSync(projectDir, { withFileTypes: true })) {
      if (!session.isDirectory() || !archived.has(session.name)) continue
      const dir = join(projectDir, session.name)
      const files = readdirSync(dir)
      out.push({
        rel: `sessions/${project.name}/${session.name}`,
        dir,
        project: project.name,
        id: session.name,
        files: files.length,
        bytes: files.reduce((sum, f) => sum + statSync(join(dir, f)).size, 0),
      })
    }
  }
  return out
}

/** 受管 ignore 的区块标题，同时是 .gitignore 里的标记文本。 */
const ARCHIVED_IGNORE_TITLE = '归档会话（自动生成，勿手改）'
const MANAGED_IGNORE_BLOCKS = [
  { title: '敏感身份与凭据（绝不同步）', entries: () => NEVER_SYNC_SENSITIVE },
  { title: '机器本地与体积（不同步）', entries: () => NEVER_SYNC_LOCAL },
  { title: ARCHIVED_IGNORE_TITLE, entries: home => archivedSessionDirs(home).map(d => `${d.rel}/`) },
]
const ignoreBegin = title => `# >>> dsh-sync ${title} >>>`
const ignoreEnd = title => `# <<< dsh-sync ${title} <<<`

/**
 * 维护 .gitignore 里的受管区块：敏感身份 / 机器本地 / 归档会话。
 * 为什么必须写：`git add -A` 看的是文件系统，不写进 .gitignore 就会被提交；
 * 实测踩过一次：95 个文件里 38 个是归档。凭据同理，且后果不可逆。
 * @param home - DSH_HOME
 * @returns 各区块条目数与是否改动
 */
export function syncManagedIgnores(home) {
  const file = join(home, '.gitignore')
  const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const counts = {}
  const bodies = []
  let rest = current
  for (const block of MANAGED_IGNORE_BLOCKS) {
    const entries = block.entries(home)
    counts[block.title] = entries.length
    const begin = ignoreBegin(block.title)
    const end = ignoreEnd(block.title)
    const start = rest.indexOf(begin)
    const stop = rest.indexOf(end)
    if (start >= 0 && stop > start) rest = rest.slice(0, start) + rest.slice(stop + end.length)
    if (entries.length > 0) bodies.push([begin, ...entries, end].join('\n'))
  }
  const head = rest.replace(/\s+$/, '')
  const next = [...(head.length > 0 ? [head] : []), ...bodies].join('\n\n') + '\n'
  if (next === current) return { counts, changed: false, file }
  writeFileSync(file, next)
  return { counts, changed: true, file }
}

/**
 * 兼容旧调用：只关心归档区块的条目数。
 * @param home - DSH_HOME
 * @returns 归档条目数与是否改动
 */
export function syncArchivedIgnores(home) {
  const managed = syncManagedIgnores(home)
  return { entries: managed.counts[ARCHIVED_IGNORE_TITLE] ?? 0, changed: managed.changed, file: managed.file }
}
/**
 * 把本地已归档的会话移入回收站，而不是删除。
 * dsh 的「归档」是隐藏、数据保留；这里也保持可恢复，默认只列清单。
 * @param home - DSH_HOME
 * @param options.apply - 真的移入 .dsh-sync/trash/<时间戳>/
 * @returns 归档标记数、命中目录、以及回收站路径（未应用时为 null）
 */
export function pruneArchived(home, { apply = false } = {}) {
  const targets = archivedSessionDirs(home)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const trash = join(home, '.dsh-sync', 'trash', stamp)
  if (apply) {
    for (const target of targets) {
      const dest = join(trash, target.project, target.id)
      mkdirSync(dirname(dest), { recursive: true })
      renameSync(target.dir, dest)
    }
  }
  return { archived: archivedSessionIds(home).size, targets, applied: apply, trash: apply ? trash : null }
}

/**
 * 清空回收站：这是唯一真正删除归档会话的地方，必须显式调用。
 * @param home - DSH_HOME
 * @returns 删除的目录数与字节数
 */
export function emptyTrash(home) {
  const root = join(home, '.dsh-sync', 'trash')
  if (!existsSync(root)) return { dirs: 0, bytes: 0 }
  const size = dir => readdirSync(dir, { withFileTypes: true })
    .reduce((sum, e) => sum + (e.isDirectory() ? size(join(dir, e.name)) : statSync(join(dir, e.name)).size), 0)
  const dirs = readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).length
  const bytes = size(root)
  rmSync(root, { recursive: true, force: true })
  return { dirs, bytes }
}
/** 初始化：生成设备身份与同步目录。 */
export function init(home) {
  const existed = existsSync(join(home, '.device-id'))
  const id = deviceId(home, { create: true })
  mkdirSync(ledgerDir(home), { recursive: true })
  mkdirSync(join(home, 'sessions'), { recursive: true })
  return { id, created: !existed, home, ledgerDir: ledgerDir(home), repo: isRepo(home) }
}
