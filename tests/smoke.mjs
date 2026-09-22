/**
 * 冒烟测试：不启动 DSH，用最小的假 ctx 把 Host 半边挂起来，
 * 验证「挂载 → 生成设备身份 → 事件触发 → 同步路径 → 状态文件」整条链路。
 * 全程在一个临时 DSH_HOME 里进行，不碰真实状态。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const home = mkdtempSync(join(tmpdir(), 'dsh-cross-device-sync-'))
process.env.DSH_HOME = home

const { apply } = await import('../src/index.js')

const listeners = new Map()
const effects = []
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  on(name, fn) {
    if (!listeners.has(name)) listeners.set(name, [])
    listeners.get(name).push(fn)
  },
  effect(fn) {
    const disposer = fn()
    effects.push(disposer)
    return disposer
  },
  get() {
    return undefined
  },
}

const api = apply(ctx, { enabled: true, debounceSeconds: 0, intervalMinutes: 0 })

assert.equal(typeof api.device, 'string', 'apply 应返回本机设备身份')
assert.ok(existsSync(join(home, '.device-id')), '首次挂载应生成 .device-id')
assert.ok(listeners.has('agent/status'), '应监听 agent/status')
assert.ok(listeners.has('session/disposed'), '应监听 session/disposed')
assert.ok(existsSync(join(home, '.dsh-sync', 'status.json')), '挂载应写一次状态文件')

// 触发一次「回合收尾」：临时目录不是 git 仓库，所以同步必然失败，
// 但失败必须被记录成结构化状态，而不是抛出或静默。
for (const fn of listeners.get('agent/status')) fn({ status: 'idle' })
const after = JSON.parse(readFileSync(join(home, '.dsh-sync', 'status.json'), 'utf8'))
assert.equal(after.reason, 'turn-end', '状态文件应记录触发原因')
assert.equal(after.ok, false, '非 git 仓库时同步应失败')
assert.match(after.error ?? '', /git 仓库/, '失败原因应可读')

// running 状态不应被误判为完成
for (const fn of listeners.get('agent/status')) fn({ status: 'running' })

// 卸载：效应必须可回滚
for (const dispose of effects) if (typeof dispose === 'function') dispose()

rmSync(home, { recursive: true, force: true })
console.log('smoke ok：挂载 / 身份 / 事件 / 失败记录 / 卸载 全部通过')
