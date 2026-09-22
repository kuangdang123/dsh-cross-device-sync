/**
 * 路由冒烟测试：不启动 DSH，用一个假 ctx 抓住 Host 半边注册的路由，
 * 再用假的 req/res 走一遍 GET /status、GET /sessions、POST /run 与信任围栏。
 * 全程在临时 DSH_HOME 里，不碰真实状态。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const home = mkdtempSync(join(tmpdir(), 'dsh-cross-device-sync-routes-'))
process.env.DSH_HOME = home

// 一份明文（compression: none）会话日志做夹具：不需要 zstd 就能走通转写投影。
const fixtureDir = join(home, 'sessions', '--tmp--proj--', 'session-11111111-2222-3333-4444-555555555555')
mkdirSync(fixtureDir, { recursive: true })
writeFileSync(
  join(fixtureDir, 'session.jsonl'),
  [
    JSON.stringify({ type: 'session', version: 0, id: 'session-11111111-2222-3333-4444-555555555555', createdAt: 1, cwd: 'D:\\tmp\\proj', agentPreset: 'ptc' }),
    JSON.stringify({ type: 'user/message', seq: 1, time: 2, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } }),
    JSON.stringify({ type: 'tool/call', seq: 2, time: 3, data: { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{"command":"pwd"}' } }),
    JSON.stringify({ type: 'assistant/message', seq: 3, time: 4, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '已在 D:\\tmp\\proj' }] } } }),
  ].join('\n') + '\n',
)

const { apply } = await import('../src/index.js')

let route = null
const effects = []
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  on: () => {},
  effect: fn => {
    const disposer = fn()
    effects.push(disposer)
    return disposer
  },
  // 插件用 ctx.inject(['webServer'], …) 等 webServer 就绪；桩里立即满足。
  inject(deps, callback) {
    return callback({
      effect: fn => {
        const disposer = fn()
        effects.push(disposer)
        return disposer
      },
      webServer: {
        register: registration => {
          route = registration
          return () => {
            route = null
          }
        },
      },
    })
  },
  get: () => undefined,
}

apply(ctx, { enabled: true, debounceSeconds: 0 })
assert.ok(route !== null, '挂载后应注册 HTTP 路由')
assert.equal(route.kind, 'prefix')
assert.equal(route.path, '/cross-device-sync')

function fakeReq({ method = 'GET', url = '/cross-device-sync/status', host = '127.0.0.1:3080', remote = '127.0.0.1' } = {}) {
  return {
    method,
    url,
    headers: { host },
    socket: { remoteAddress: remote },
    async *[Symbol.asyncIterator]() {},
  }
}
function fakeRes() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = body ?? ''
    },
  }
}

async function call(req) {
  const res = fakeRes()
  await route.handler(req, res)
  return { status: res.status, json: res.body ? JSON.parse(res.body) : null }
}

const status = await call(fakeReq())
assert.equal(status.status, 200)
assert.equal(status.json.ok, true)
assert.equal(typeof status.json.device, 'string', 'status 应返回本机设备身份')
assert.ok('sessions' in status.json && 'verdicts' in status.json, 'status 应含会话统计')

const sessions = await call(fakeReq({ url: '/cross-device-sync/sessions' }))
assert.equal(sessions.status, 200)
assert.ok(Array.isArray(sessions.json.sessions), 'sessions 应返回数组')

// 非 loopback 客户端必须被拒绝：信任围栏是这块的攻击面
const denied = await call(fakeReq({ remote: '192.168.1.20' }))
assert.equal(denied.status, 403, '非 loopback 套接字应 403')
const deniedHost = await call(fakeReq({ host: 'evil.example.com' }))
assert.equal(deniedHost.status, 403, '非 loopback Host 头应 403')

// 手动同步：临时目录不是 git 仓库，必须失败但保持结构化响应，而不是抛异常
const run = await call(fakeReq({ method: 'POST', url: '/cross-device-sync/run' }))
assert.equal(run.status, 409, '非 git 仓库时应 409')
assert.equal(run.json.ok, false)
assert.match(run.json.error ?? '', /git 仓库/)

const unknown = await call(fakeReq({ url: '/cross-device-sync/nope' }))
assert.equal(unknown.status, 404)

// 转写：只读投影，user/tool-call/assistant 都在
const rel = 'sessions/--tmp--proj--/session-11111111-2222-3333-4444-555555555555/session.jsonl'
const transcript = await call(fakeReq({ url: `/cross-device-sync/transcript?rel=${encodeURIComponent(rel)}` }))
assert.equal(transcript.status, 200)
assert.equal(transcript.json.sessionId, 'session-11111111-2222-3333-4444-555555555555')
assert.equal(transcript.json.messageCount, 3, '应有 user / tool-call / assistant 三条')
assert.deepEqual(transcript.json.messages.map(m => m.role), ['user', 'tool-call', 'assistant'])

// 白名单：不在本地可见集合里的 rel（含路径穿越）一律 404，绝不按路径读盘
const traversal = await call(fakeReq({ url: '/cross-device-sync/transcript?rel=../../.credentials.yaml' }))
assert.equal(traversal.status, 404, '路径穿越必须被白名单挡掉')
assert.match(traversal.json.error ?? '', /不在本地可见集合/)

// 会话列表里应出现夹具，且未知归属默认记为本机（不是 null）
const list = await call(fakeReq({ url: '/cross-device-sync/sessions' }))
const fixture = list.json.sessions.find(s => s.id === 'session-11111111-2222-3333-4444-555555555555')
assert.ok(fixture, 'sessions 应列出这条夹具')
assert.equal(typeof fixture.device, 'string', '没有台账归属时应默认记为本机，而不是 null')

for (const dispose of effects) if (typeof dispose === 'function') dispose()
rmSync(home, { recursive: true, force: true })
console.log('routes ok：注册 / 状态 / 会话 / 围栏 / 手动同步 / 404 全部通过')
