#!/usr/bin/env node
/**
 * 零依赖的 Client 打包器。
 *
 * 产物契约（与官方 tsdown 预设一致，来自 packages/client/tsdown.client.ts）：
 *   1. 文件以 window.__ModuleLoader__.load({ id, factory }) 开头；
 *   2. factory 收到一个同步的 require（模块表），只能取 PLATFORM_MODULES 里的项；
 *   3. 内部用 module/exports 的 CJS 约定。
 *
 * 因为客户端半边只用 React（模块表已提供）且不含 CSS Modules，
 * 这里不需要 tsdown/lightningcss：直接读 src/client/index.cjs 包一层即可。
 * 将来要写 TSX / CSS Modules 时，再换成官方预设并同步 build/ 下的副本。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const source = readFileSync(join(root, 'src/client/index.cjs'), 'utf8')
const out = join(root, 'lib/client.js')

const artifact = [
  `window.__ModuleLoader__.load({`,
  `  id: ${JSON.stringify(pkg.name)},`,
  `  factory: (require) => {`,
  `    var module = { exports: {} }; var exports = module.exports;`,
  source,
  `    return module.exports;`,
  `  },`,
  `});`,
  '',
].join('\n')

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, artifact)
console.log(`built ${out} (${artifact.length} bytes, id=${pkg.name})`)
