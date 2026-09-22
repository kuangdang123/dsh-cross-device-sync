/**
 * 闸门与回收站测试：不启动 DSH，只在临时 HOME 里验证两件**必须失败/必须可恢复**的事。
 *
 *   ① 敏感文件（.credentials.yaml 等）即使被 force-add 进索引，也必须被闸门拦下；
 *   ② prune 只把归档会话移进回收站（可恢复），真正删除要显式 emptyTrash。
 *
 * 全程在临时目录里进行，不碰真实状态，也不依赖网络。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

const home = mkdtempSync(join(tmpdir(), 'dsh-sync-guard-'))
const git = args => spawnSync('git', ['-C', home, ...args], { encoding: 'utf8' })

const {
  emptyTrash,
  escapedNeverSyncPaths,
  guardNeverSync,
  pruneArchived,
  syncManagedIgnores,
} = await import('../src/engine.js')

// ── 场景布置：凭据文件 + 一个被归档的会话 ──────────────────────────────────
writeFileSync(join(home, '.credentials.yaml'), 'HUYA_API_KEY: dummy\n')
mkdirSync(join(home, 'storages'), { recursive: true })
writeFileSync(
  join(home, 'storages', 'workspace.json'),
  JSON.stringify({ global: { initialized: true, workspaceIds: [], archivedSessionIds: ['session-archived-1'] } }),
)
const archivedDir = join(home, 'sessions', '--D-Desktop--', 'session-archived-1')
mkdirSync(archivedDir, { recursive: true })
writeFileSync(join(archivedDir, 'session.v3.jsonl'), '{"type":"session"}\n')
// 一个不该被 prune 的活跃会话
const liveDir = join(home, 'sessions', '--D-Desktop--', 'session-live-1')
mkdirSync(liveDir, { recursive: true })
writeFileSync(join(liveDir, 'session.v3.jsonl'), '{"type":"session"}\n')

// ── ① 受管 ignore：三类区块都要写出来 ──────────────────────────────────────
const ignored = syncManagedIgnores(home)
const gitignore = readFileSync(join(home, '.gitignore'), 'utf8')
assert.equal(ignored.changed, true, '首次应写出 .gitignore')
assert.match(gitignore, /^\.credentials\.yaml$/m, '敏感文件必须进 ignore')
assert.match(gitignore, /^\.device-id$/m, '设备身份必须进 ignore')
assert.match(gitignore, /^profiles\/$/m, 'profiles/ 必须进 ignore')
assert.match(gitignore, /^sessions\/--D-Desktop--\/session-archived-1\/$/m, '归档会话必须进 ignore')
assert.ok(gitignore.includes('>>> dsh-sync 敏感身份与凭据（绝不同步） >>>'), '应有敏感区块标记')
// 幂等：再跑一次不应产生变化
assert.equal(syncManagedIgnores(home).changed, false, '重复写入应无变化')

// ── ② 非仓库 / 干净仓库：闸门放行 ─────────────────────────────────────────
assert.deepEqual(escapedNeverSyncPaths(home), [], '还不是 git 仓库时应返回空')
git(['init', '-b', 'main'])
assert.deepEqual(escapedNeverSyncPaths(home), [], 'ignore 生效后不应有任何命中')
guardNeverSync(home) // 不抛即通过

// ── ③ 被 force-add 的凭据：闸门必须拦下并报出路径 ─────────────────────────
git(['add', '-f', '.credentials.yaml'])
assert.deepEqual(escapedNeverSyncPaths(home), ['.credentials.yaml'], 'force-add 的敏感文件必须被查出')
assert.throws(
  () => guardNeverSync(home),
  /绝不该进 git.*\.credentials\.yaml/s,
  '闸门必须抛错并点名该路径',
)
// 机器本地目录同样拦
git(['add', '-f', 'storages/workspace.json'])
assert.deepEqual(
  escapedNeverSyncPaths(home),
  ['.credentials.yaml', 'storages/workspace.json'],
  '敏感与机器本地路径都要被查出',
)
git(['rm', '--cached', '-r', '--quiet', '.credentials.yaml', 'storages/workspace.json'])
assert.deepEqual(escapedNeverSyncPaths(home), [], '移出索引后恢复放行')

// ── ④ prune：默认只列不删，--apply 只移进回收站 ───────────────────────────
const listed = pruneArchived(home)
assert.equal(listed.targets.length, 1, '只应命中 1 个归档会话')
assert.equal(listed.applied, false, '默认不应真的动文件')
assert.ok(existsSync(archivedDir), '默认不删：目录仍在')

const applied = pruneArchived(home, { apply: true })
assert.equal(applied.applied, true)
assert.equal(applied.trash !== null, true, '应返回回收站路径')
assert.equal(existsSync(archivedDir), false, 'apply 后原目录应被移走')
assert.ok(existsSync(join(applied.trash, '--D-Desktop--', 'session-archived-1')), '应能在回收站里找到（可恢复）')
assert.ok(existsSync(liveDir), '未归档的会话不能被碰')

// ── ⑤ emptyTrash：唯一真正删除的地方 ──────────────────────────────────────
const emptied = emptyTrash(home)
assert.equal(emptied.dirs, 1, '应报告删掉 1 个目录')
assert.ok(emptied.bytes > 0, '应报告回收的字节数')
assert.equal(existsSync(applied.trash), false, '回收站应被清空')
assert.ok(existsSync(liveDir), '活跃会话依然不能被碰')

rmSync(home, { recursive: true, force: true })
console.log('guard ok：受管 ignore / 敏感闸门 / 回收站 prune / emptyTrash 全部通过')
