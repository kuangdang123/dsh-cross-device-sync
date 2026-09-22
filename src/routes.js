/**
 * Host 侧 HTTP 路由：Client 半边取数的唯一入口。
 *
 * 安全边界与 dsh-ssh / git-graph 一致：只接受 loopback 套接字 + loopback Host 头，
 * X-Forwarded-For 一律不信。本插件只读自己的同步状态，不接受任意路径参数。
 */
const PREFIX = '/cross-device-sync'
const MAX_BODY = 64 * 1024

function isIPv4Loopback(v4) {
  const parts = v4.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

function isLoopbackAddress(address) {
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice(7))
  return isIPv4Loopback(normalized)
}

function isLoopbackRequest(req) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false
  const host = req.headers?.host
  if (typeof host !== 'string') return false
  try {
    const url = new URL(`http://${host}`)
    const name = url.hostname
    return name === 'localhost' || name === '[::1]' || isIPv4Loopback(name)
  } catch {
    return false
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 注册本插件的路由。
 * @param webServer - 宿主 webServer 服务实例（调用方用 ctx.get('webServer') 取，避免依赖 ctx 属性代理）
 * @param api - 由 src/index.js 提供的同步能力（status / sessions / runSync）
 * @returns 注销函数
 */
export function registerRoutes(webServer, api) {
  const handler = async (req, res) => {
    if (!isLoopbackRequest(req)) {
      sendJson(res, 403, { ok: false, error: 'loopback clients only' })
      return
    }
    let url
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad request url' })
      return
    }
    const route = url.pathname.slice(PREFIX.length)
    try {
      if (req.method === 'GET' && (route === '/status' || route === '')) {
        sendJson(res, 200, { ok: true, ...api.status() })
        return
      }
      if (req.method === 'GET' && route === '/sessions') {
        sendJson(res, 200, { ok: true, ...api.sessions() })
        return
      }
      if (req.method === 'POST' && route === '/run') {
        await readBody(req)
        const result = api.runSync()
        sendJson(res, result.error === null ? 200 : 409, { ok: result.error === null, ...result })
        return
      }
      sendJson(res, 404, { ok: false, error: `unknown route ${route}` })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const dispose = webServer.register({ kind: 'prefix', path: PREFIX, handler })
  return dispose
}
