// 模型下载地址面板的纯逻辑：手动放置说明、复制文本、打开链接；状态与下载动作仍只走 stores/models.ts
import { isNativeAvailable } from '@/native/bridge'
import { openIntent } from '@/native/system'
import type { ModelSourceFile, ModelStateName } from '@/native/model'

/** 手动放置说明里的步骤文案（目录由原生给出） */
export const MANUAL_STEPS: readonly string[] = [
  '在能联网的设备上下载下面的全部文件，并核对 sha256。',
  '把文件原样（不改名）放进应用私有目录下的模型目录，目录见下方。',
  '回到本页点「校验」，通过后状态变为已安装。',
]

/** 手动放置的目录提示（私有目录需要 adb 的 run-as 或 root，普通手机无法直接访问） */
export const MANUAL_DIR_HINT = '该目录位于应用私有 files 目录内，普通文件管理器看不到，需要 adb（debug 包的 run-as）放入。'

/** 可以触发下载的状态：未安装、未校验、文件损坏 */
const DOWNLOADABLE: ReadonlySet<ModelStateName> = new Set(['absent', 'unverified', 'corrupt'])

/**
 * 该状态下是否显示「点击下载」。
 *
 * @param state 模型状态
 * @returns 未安装、未校验或损坏时为 true
 * @example canDownload('absent') // true
 */
export function canDownload(state: ModelStateName): boolean {
  return DOWNLOADABLE.has(state)
}

/**
 * 生成手动放置的目录全路径说明（相对应用私有 files 目录）。
 *
 * @param dir 原生给出的模型目录，如 `models/a`
 * @returns 如 `files/models/a/`
 * @example manualDirText('models/a') // 'files/models/a/'
 */
export function manualDirText(dir: string): string {
  return `files/${dir.replace(/^\/+|\/+$/g, '')}/`
}

/**
 * 一个文件的复制文本：文件名、sha256 与全部地址，每项一行。
 *
 * @param file 文件来源
 * @returns 多行文本
 * @example fileCopyText({ name: 'a', bytes: 1, sha256: 'x', urls: ['u'] }) // 'a\nsha256: x\nu'
 */
export function fileCopyText(file: ModelSourceFile): string {
  return [file.name, `sha256: ${file.sha256}`, ...file.urls].join('\n')
}

/**
 * 全部文件的地址清单（每个文件首选地址一行，便于贴进下载工具批量下载）。
 *
 * @param files 文件来源列表
 * @returns 每行一个地址；没有地址的文件跳过
 * @example allFirstUrls([{ name: 'a', bytes: 1, sha256: 'x', urls: ['u1', 'u2'] }]) // 'u1'
 */
export function allFirstUrls(files: ModelSourceFile[]): string {
  return files
    .map((f) => f.urls[0])
    .filter((u): u is string => !!u)
    .join('\n')
}

/**
 * 打开链接：有宿主走原生 `native.intent.open`，没有（桌面调试）退回 `window.open`。
 *
 * @param url 完整 http(s) 地址
 * @returns 是否成功拉起
 * @example await openLink('https://github.com/o/r/releases/tag/v1')
 */
export async function openLink(url: string): Promise<boolean> {
  if (isNativeAvailable()) {
    try {
      return await openIntent('url', url)
    } catch {
      return false
    }
  }
  return typeof window !== 'undefined' && window.open(url, '_blank', 'noopener') !== null
}

/** 弹窗底部主按钮：下载、删除，或下载中（置灰） */
export type FooterAction = 'download' | 'remove' | 'downloading'

/**
 * 弹窗底部的按钮布局：未安装或损坏显示「下载」，已下载显示「删除」，下载中置灰；
 * 手动放入、未校验的文件额外给一个「校验」。
 *
 * @param state 模型状态
 * @returns `primary` 主按钮；`verify` 是否另显示「校验」
 * @example footerOf('absent') // { primary: 'download', verify: false }
 */
export function footerOf(state: ModelStateName): { primary: FooterAction; verify: boolean } {
  if (state === 'downloading') return { primary: 'downloading', verify: false }
  if (state === 'installed') return { primary: 'remove', verify: false }
  if (state === 'unverified') return { primary: 'remove', verify: true }
  return { primary: 'download', verify: false }
}
