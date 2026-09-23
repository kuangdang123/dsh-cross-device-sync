/**
 * Client 半边（浏览器）。产物是 __ModuleLoader__ 工厂，见 build/build-client.mjs。
 *
 * 只做两件事：
 *   1. 在 root 作用域的 `sidebar.panellist` 里注册一个入口图标（id = cross-device-sync）；
 *   2. 在 root 作用域的 `main` keyed 槽里注册同 id 的面板组件。
 * 所有数据来自本包 Host 半边的 /cross-device-sync/* 路由；组件本身不碰 ctx。
 */
const React = require('react')
const h = React.createElement

const PANEL_ID = 'cross-device-sync'
const BASE = '/cross-device-sync'

async function request(path, init) {
  const url = `${BASE}${path}`
  let res
  try {
    res = await fetch(url, init)
  } catch (err) {
    return { ok: false, error: `取不到 ${url}：${err instanceof Error ? err.message : String(err)}`, diag: { url, status: null, contentType: null, body: null } }
  }
  const type = res.headers.get('content-type') || ''
  const text = await res.text()
  const diag = { url, status: res.status, contentType: type || '(空)', body: text.slice(0, 160) }
  // Host 半边没挂载时请求会落到 SPA fallback，拿回一段 HTML——必须与真正的接口错误区分开，
  // 否则用户只看到「毫无反应」。诊断块把这几个原始事实直接摆出来。
  if (!type.includes('json')) {
    return {
      ok: false,
      diag,
      error: res.status === 404
        ? 'Host 半边未挂载：插件行只在 profile 启动时组合，请重启 web profile'
        : `Host 半边未就绪（HTTP ${res.status}，content-type=${type || '空'}）——重启 web profile 后重试`,
    }
  }
  try {
    return JSON.parse(text)
  } catch {
    return { ok: false, diag, error: `响应不是合法 JSON（HTTP ${res.status}）` }
  }
}

const fmtMB = bytes => `${(bytes / 1048576).toFixed(1)} MB`
const fmtTime = ms => new Date(ms).toLocaleString()

// ── 入口图标 ────────────────────────────────────────────────────────────────
function SyncIcon(props) {
  const size = props && props.size ? props.size : 18
  return h(
    'svg',
    { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
    h('path', {
      d: 'M4 12a8 8 0 0 1 13.66-5.66M20 12a8 8 0 0 1-13.66 5.66',
      stroke: 'currentColor',
      'stroke-width': '1.6',
      'stroke-linecap': 'round',
    }),
    h('path', { d: 'M17 3.5V7h-3.5M7 20.5V17h3.5', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round' }),
  )
}

// ── 面板 ────────────────────────────────────────────────────────────────────
const rowStyle = { display: 'flex', gap: '8px', alignItems: 'baseline', padding: '4px 0', fontSize: '12px' }
const dim = { opacity: 0.6 }

/** 相对时间：面板里比绝对时间戳好读，省去每次换算。 */
function fmtAgo(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}
const shortTime = ms => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toLocaleString() : '—')

function DeviceSection(props) {
  const { status, selected, onSelect } = props
  const devices = status && status.devices ? status.devices : []
  const label = device => {
    if (device === 'all') return '全部设备'
    const found = devices.find(d => d.device === device)
    const when = found && found.updatedAt ? ` · ${fmtAgo(Date.parse(found.updatedAt))}` : ''
    return `${found && found.self ? '本机 · ' : ''}${String(device).slice(0, 8)}${found ? ` (${found.files})` : ''}${when}`
  }
  return h(
    'div',
    { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', margin: '8px 0' } },
    ['all'].concat(devices.map(d => d.device)).map(id => {
      const found = devices.find(d => d.device === id)
      const title = id === 'all'
        ? '不筛选'
        : `${id}\n文件 ${found?.files ?? 0} · 最后活动 ${found?.updatedAt ? shortTime(Date.parse(found.updatedAt)) : '未知'}`
      return h(
        'button',
        {
          key: id,
          type: 'button',
          title,
          onClick: () => onSelect(id),
          style: {
            padding: '2px 10px',
            borderRadius: '999px',
            fontSize: '12px',
            cursor: 'pointer',
            background: 'transparent',
            color: 'inherit',
            border: '1px solid currentColor',
            opacity: selected === id ? 1 : 0.55,
          },
        },
        label(id),
      )
    }),
  )
}

function SessionList(props) {
  const rows = props.rows
  if (rows.length === 0) return h('div', { style: { ...dim, fontSize: '12px' } }, '该设备暂无本地可见的会话。')
  return h(
    'div',
    null,
    rows.slice(0, 300).map(s => {
      const at = typeof s.updatedAt === 'number' ? s.updatedAt : Date.parse(s.updatedAt)
      return h(
        'button',
        {
          key: s.rel,
          type: 'button',
          onClick: () => props.onOpen(s.rel),
          title: `只读打开这条会话（不会改动原文件）\n最后改动：${shortTime(at)}（${s.device ? s.device.slice(0, 8) : '未知设备'}）`,
          style: { ...rowStyle, display: 'flex', width: '100%', textAlign: 'left', background: 'transparent', color: 'inherit', border: 'none', borderBottom: '1px solid currentColor', cursor: 'pointer', font: 'inherit' },
        },
        h('span', { style: { minWidth: '150px', ...dim } }, s.project.replace(/^-+|-+$/g, '') || 'root'),
        h('span', { style: { fontFamily: 'ui-monospace, monospace' } }, s.id.slice(0, 18)),
        // 时间放在设备标记旁边：一眼看出"这条是谁、什么时候写的"
        h('span', { style: { marginLeft: 'auto', ...dim, whiteSpace: 'nowrap' } }, fmtAgo(at)),
        h('span', { style: { ...dim, minWidth: '150px', textAlign: 'right' } }, `${s.device ? s.device.slice(0, 8) : '—'} · ${fmtMB(s.bytes)}`),
      )
    }),
  )
}

/** 只读转写视图：把某个会话日志投影成消息流。绝不写回原文件。 */
function Transcript(props) {
  const [data, setData] = React.useState(null)
  const [error, setError] = React.useState(null)

  React.useEffect(() => {
    let alive = true
    request(`/transcript?rel=${encodeURIComponent(props.rel)}`).then(result => {
      if (!alive) return
      if (result.ok === false) setError(result.error || '读取失败')
      else setData(result)
    })
    return () => {
      alive = false
    }
  }, [props.rel])

  const roleStyle = role => ({
    user: { fontWeight: 600 },
    assistant: {},
    context: { opacity: 0.7 },
    'tool-call': { opacity: 0.75, fontFamily: 'ui-monospace, monospace', fontSize: '11px' },
    'tool-result': { opacity: 0.55, fontFamily: 'ui-monospace, monospace', fontSize: '11px' },
  }[role] ?? {})

  return h(
    'div',
    null,
    h(
      'button',
      {
        type: 'button',
        onClick: props.onClose,
        style: { padding: '3px 12px', fontSize: '12px', cursor: 'pointer', background: 'transparent', color: 'inherit', border: '1px solid currentColor', borderRadius: '6px' },
      },
      '← 返回会话列表',
    ),
    error ? h('div', { style: { fontSize: '12px', margin: '8px 0' } }, `⚠ ${error}`) : null,
    data
      ? h(
          'div',
          null,
          h(
            'div',
            { style: { ...dim, fontSize: '11px', margin: '8px 0', fontFamily: 'ui-monospace, monospace' } },
            `${data.sessionId ?? props.rel} · cwd=${data.cwd ?? '-'} · ${data.messageCount} 条消息${data.truncated ? '（只显示最后若干条）' : ''} · 只读`,
          ),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            data.messages.map((m, i) =>
              h(
                'div',
                { key: `${m.seq}-${i}`, style: { fontSize: '12px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', borderLeft: '2px solid currentColor', paddingLeft: '8px', opacity: 0.95 } },
                h('div', { style: { ...dim, fontSize: '10px' } }, `#${m.seq} ${m.role}`),
                h('div', { style: roleStyle(m.role) }, m.text),
              ),
            ),
          ),
        )
      : h('div', { style: { ...dim, fontSize: '12px', margin: '8px 0' } }, '读取中…'),
  )
}

function Panel() {
  const [status, setStatus] = React.useState(null)
  const [sessions, setSessions] = React.useState([])
  const [error, setError] = React.useState(null)
  const [diag, setDiag] = React.useState(null)
  const [selected, setSelected] = React.useState('all')
  const [busy, setBusy] = React.useState(false)
  const [openRel, setOpenRel] = React.useState(null)

  const refresh = React.useCallback(async () => {
    try {
      const [st, ss] = await Promise.all([request('/status'), request('/sessions')])
      if (st.ok === false) {
        setDiag(st.diag ?? null)
        throw new Error(st.error || '状态接口失败')
      }
      if (ss.ok === false) {
        setDiag(ss.diag ?? null)
        throw new Error(ss.error || '会话接口失败')
      }
      setDiag(null)
      setStatus(st)
      setSessions(ss.sessions || [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  React.useEffect(() => {
    refresh()
  }, [refresh])

  const onRun = async () => {
    setBusy(true)
    try {
      const result = await request('/run', { method: 'POST' })
      if (result.ok === false) setError(result.error || '同步失败')
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const rows = selected === 'all' ? sessions : sessions.filter(s => s.device === selected)
  const conflicts = status && status.conflicts ? status.conflicts.length : 0

  // 打开某条会话时切到只读转写视图：跨设备看历史，不触碰原文件、也不切换当前会话。
  if (openRel !== null) {
    return h(
      'div',
      { style: { padding: '16px 20px', fontSize: '13px', overflowY: 'auto', height: '100%' } },
      h('h2', { style: { margin: '0 0 8px', fontSize: '15px' } }, '设备同步 · 只读历史'),
      h(Transcript, { rel: openRel, onClose: () => setOpenRel(null) }),
    )
  }

  return h(
    'div',
    { style: { padding: '16px 20px', fontSize: '13px', overflowY: 'auto', height: '100%' } },
    h('h2', { style: { margin: '0 0 4px', fontSize: '15px' } }, '设备同步'),
    status
      ? h(
          'div',
          { style: { ...dim, fontSize: '12px' } },
          h(
            'div',
            null,
            `本机 ${String(status.device).slice(0, 8)} · ${status.sessions} 个会话 / ${fmtMB(status.bytes)} · `,
            `远端更新 ${status.remoteAhead ? status.remoteAhead.length : 0} · 冲突 ${conflicts} · `,
            status.git && status.git.repo ? `git ${status.git.remote ? '已连远端' : '未配远端'}` : 'git 未初始化',
          ),
          // 最后同步时间：来自仓库最近一次提交，同时给出提交者（即哪台设备）
          status.lastSync
            ? h(
                'div',
                { title: `${status.lastSync.subject || ''}` },
                `最后同步 ${fmtAgo(status.lastSync.at)}（${shortTime(status.lastSync.at)}`,
                status.lastSync.author ? ` · 设备 ${String(status.lastSync.author).slice(0, 8)}` : '',
                '）',
              )
            : h('div', null, '尚无同步提交'),
        )
      : h('div', { style: { ...dim, fontSize: '12px' } }, '读取中…'),
    h(
      'div',
      { style: { display: 'flex', gap: '8px', alignItems: 'center', margin: '10px 0' } },
      h(
        'button',
        {
          type: 'button',
          onClick: onRun,
          disabled: busy,
          style: { padding: '3px 12px', fontSize: '12px', cursor: busy ? 'default' : 'pointer', background: 'transparent', color: 'inherit', border: '1px solid currentColor', borderRadius: '6px' },
        },
        busy ? '同步中…' : '立即同步',
      ),
      h(
        'button',
        {
          type: 'button',
          onClick: refresh,
          style: { padding: '3px 12px', fontSize: '12px', cursor: 'pointer', background: 'transparent', color: 'inherit', border: '1px solid currentColor', borderRadius: '6px', opacity: 0.7 },
        },
        '刷新',
      ),
    ),
    error ? h('div', { style: { color: 'inherit', opacity: 0.9, fontSize: '12px', margin: '6px 0' } }, `⚠ ${error}`) : null,
    diag
      ? h(
          'div',
          { style: { ...dim, fontFamily: 'ui-monospace, monospace', fontSize: '11px', margin: '2px 0 6px', wordBreak: 'break-all' } },
          `诊断：${diag.url} → HTTP ${diag.status ?? '无响应'} · content-type=${diag.contentType ?? '-'}`,
          diag.body ? h('div', null, `body 前 160 字：${diag.body}`) : null,
          h('div', { style: { marginTop: '2px' } }, 'Host 端点应为 JSON；拿到 HTML/404 说明插件行没挂载（重启 profile）'),
        )
      : null,
    status && status.conflicts && status.conflicts.length > 0
      ? h(
          'div',
          { style: { fontSize: '12px', margin: '6px 0' } },
          '以下会话两端都改过，插件不会自动合并：',
          h('ul', { style: { margin: '4px 0 0 16px' } }, status.conflicts.map(c => h('li', { key: c.rel }, `${c.id}（本地 ${c.bytes}B）`))),
        )
      : null,
    h(DeviceSection, { status, selected, onSelect: setSelected }),
    status && status.sessions
      ? h('div', { style: { ...dim, fontSize: '12px', marginBottom: '4px' } }, `本地可见 ${rows.length} 个会话日志`)
      : null,
    h(SessionList, { rows, onOpen: setOpenRel }),
    sessions.length > 0
      ? h(
          'div',
          { style: { ...dim, fontSize: '11px', marginTop: '12px' } },
          `共 ${rows.length} 条；最新一条 ${fmtAgo(Math.max(...sessions.map(s => (typeof s.updatedAt === 'number' ? s.updatedAt : Date.parse(s.updatedAt) || 0))))}。`,
          '跨设备继续会话需要该会话的 cwd 在本机存在，见 SYNC.md。',
        )
      : null,
  )
}

// ── 插件 ────────────────────────────────────────────────────────────────────
const name = 'cross-device-sync-client'
const inject = ['slots']

function apply(ctx) {
  const disposers = [
    ctx.slots.inject('sidebar.panellist', () =>
      ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: '设备同步' }, SyncIcon),
    ),
    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel)),
  ]
  ctx.effect(() => () => {
    for (const dispose of disposers) if (typeof dispose === 'function') dispose()
  }, 'cross-device-sync: panel entries')
}

module.exports = { name, inject, apply }
