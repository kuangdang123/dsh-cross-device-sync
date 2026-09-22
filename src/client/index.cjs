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
  let res
  try {
    res = await fetch(`${BASE}${path}`, init)
  } catch (err) {
    return { ok: false, error: `取不到 ${BASE}${path}：${err instanceof Error ? err.message : String(err)}` }
  }
  const type = res.headers.get('content-type') || ''
  const text = await res.text()
  // Host 半边没挂载时请求会落到 SPA fallback，拿回一段 HTML——必须与真正的接口错误区分开，
  // 否则用户只看到「毫无反应」。
  if (!type.includes('json')) {
    return {
      ok: false,
      error: res.status === 404
        ? 'Host 半边未挂载：插件行只在 profile 启动时组合，请重启 web profile'
        : `Host 半边未就绪（HTTP ${res.status}，content-type=${type || '空'}）——重启 web profile 后重试`,
    }
  }
  try {
    return JSON.parse(text)
  } catch {
    return { ok: false, error: `响应不是合法 JSON（HTTP ${res.status}）` }
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

function DeviceSection(props) {
  const { status, selected, onSelect } = props
  const devices = status && status.devices ? status.devices : []
  const label = device => {
    if (device === 'all') return '全部设备'
    const found = devices.find(d => d.device === device)
    return `${found && found.self ? '本机 · ' : ''}${String(device).slice(0, 8)}${found ? ` (${found.files})` : ''}`
  }
  return h(
    'div',
    { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', margin: '8px 0' } },
    ['all'].concat(devices.map(d => d.device)).map(id =>
      h(
        'button',
        {
          key: id,
          type: 'button',
          title: id === 'all' ? '不筛选' : id,
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
      ),
    ),
  )
}

function SessionList(props) {
  const rows = props.rows
  if (rows.length === 0) return h('div', { style: { ...dim, fontSize: '12px' } }, '该设备暂无本地可见的会话。')
  return h(
    'div',
    null,
    rows.slice(0, 300).map(s =>
      h(
        'div',
        { key: s.rel, style: rowStyle },
        h('span', { style: { minWidth: '160px', ...dim } }, s.project.replace(/^-+|-+$/g, '') || 'root'),
        h('span', { style: { fontFamily: 'ui-monospace, monospace' } }, s.id.slice(0, 20)),
        h('span', { style: dim }, s.cwd || '(无 cwd)'),
        h('span', { style: { marginLeft: 'auto', ...dim } }, s.device ? s.device.slice(0, 8) : '—', ' · ', fmtMB(s.bytes)),
      ),
    ),
  )
}

function Panel() {
  const [status, setStatus] = React.useState(null)
  const [sessions, setSessions] = React.useState([])
  const [error, setError] = React.useState(null)
  const [selected, setSelected] = React.useState('all')
  const [busy, setBusy] = React.useState(false)

  const refresh = React.useCallback(async () => {
    try {
      const [st, ss] = await Promise.all([request('/status'), request('/sessions')])
      if (st.ok === false) throw new Error(st.error || '状态接口失败')
      if (ss.ok === false) throw new Error(ss.error || '会话接口失败')
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

  return h(
    'div',
    { style: { padding: '16px 20px', fontSize: '13px', overflowY: 'auto', height: '100%' } },
    h('h2', { style: { margin: '0 0 4px', fontSize: '15px' } }, '设备同步'),
    status
      ? h(
          'div',
          { style: { ...dim, fontSize: '12px' } },
          `本机 ${String(status.device).slice(0, 8)} · ${status.sessions} 个会话 / ${fmtMB(status.bytes)} · `,
          `远端更新 ${status.remoteAhead ? status.remoteAhead.length : 0} · 冲突 ${conflicts} · `,
          status.git && status.git.repo ? `git ${status.git.remote ? '已连远端' : '未配远端'}` : 'git 未初始化',
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
    h(SessionList, { rows }),
    sessions.length > 0
      ? h(
          'div',
          { style: { ...dim, fontSize: '11px', marginTop: '12px' } },
          `最近更新：${fmtTime(Math.max(...sessions.map(s => s.mtimeMs)))}。跨设备继续会话需要该会话的 cwd 在本机存在，见 SYNC.md。`,
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
