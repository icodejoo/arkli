// 从工具注册表导出 id -> 名称的小 JSON，供深链接落地页（site/）显示工具名。
// 用法：node scripts/export-tools.mjs   （在 web/ 下执行；产物 ../site/arkli/t/tools.json）
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

/** web 工程根目录 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 输出文件：落地页同目录，页面以 /arkli/t/tools.json 读取 */
const out = resolve(root, '..', 'site', 'arkli', 't', 'tools.json')

// 借 vite 的 SSR 加载器解析 @ 别名与 TS，注册表里的 load() 动态导入不会被执行
const server = await createServer({ root, appType: 'custom', server: { middlewareMode: true, hmr: false }, logLevel: 'error' })
try {
  const { tools } = await server.ssrLoadModule('/src/tools/registry.ts')
  /** @type {Record<string, string>} */
  const map = {}
  for (const t of tools) map[t.id] = t.name
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(map) + '\n')
  console.log(`已导出 ${Object.keys(map).length} 个工具 -> ${out}`)
} finally {
  await server.close()
}
