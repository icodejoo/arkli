// 把 web/dist 同步到 app 的 assets/web：先清空目标目录，再整体拷贝。
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** web 工程根目录 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** 构建产物目录 */
const src = resolve(root, 'dist')
/** 目标目录：安卓 assets/web */
const dest = resolve(root, '..', 'app', 'src', 'main', 'assets', 'web')

if (!existsSync(src)) {
  console.error(`找不到 ${src}，请先执行 build`)
  process.exit(1)
}

rmSync(dest, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })
cpSync(src, dest, { recursive: true })
console.log(`已同步 ${src} -> ${dest}`)
