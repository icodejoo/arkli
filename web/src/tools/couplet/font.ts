// 对联字体：Ma Shan Zheng 走 Google Fonts 在线加载，有网才下载，没网不影响（回落系统楷体）

/** Google Fonts 样式表（woff2 按字切片，只下载用到的字） */
export const FONT_CSS_URL = 'https://fonts.googleapis.com/css2?family=Ma+Shan+Zheng&display=swap'
/** 注入的 link 元素 id（保证只注入一次） */
const LINK_ID = 'arkli-couplet-font'
/** 等字体的最长毫秒数，超时就按系统字体画 */
const WAIT_MS = 3000

/** 最小文档接口，便于测试注入 */
export interface FontDoc {
  /** 按 id 取元素 */
  getElementById(id: string): unknown
  /** 创建元素 */
  createElement(tag: string): { id: string; rel: string; href: string; onload: (() => void) | null; onerror: (() => void) | null }
  /** 文档头 */
  head: { appendChild(el: unknown): unknown }
  /** 字体集（旧 WebView 可能没有） */
  fonts?: { load(font: string, text?: string): Promise<unknown> }
}

/** 样式表加载结果（成功或失败都会 resolve，不会 reject） */
let sheetReady: Promise<void> | null = null

/**
 * 注入在线字体样式表（只注入一次；没有 document 或没网时静默跳过）。
 *
 * @param doc 文档，默认全局 document
 * @example loadCoupletFont()
 */
export function loadCoupletFont(doc: FontDoc | undefined = globalThis.document as unknown as FontDoc | undefined): void {
  if (!doc || sheetReady || doc.getElementById(LINK_ID)) return
  sheetReady = new Promise<void>((resolve) => {
    const link = doc.createElement('link')
    link.id = LINK_ID
    link.rel = 'stylesheet'
    link.href = FONT_CSS_URL
    link.onload = () => resolve()
    link.onerror = () => resolve()
    doc.head.appendChild(link)
  })
}

/**
 * 等这些字的字体就绪（用于 canvas 导出前）；最多等 3 秒，失败或没网都直接返回，不抛错。
 *
 * @param text 要画的文字
 * @param px 字号
 * @param doc 文档，默认全局 document
 * @returns 无；返回后 canvas 按已就绪的字体（或系统字体）绘制
 * @example await waitCoupletFont('春风送暖')
 */
export async function waitCoupletFont(text: string, px = 32, doc: FontDoc | undefined = globalThis.document as unknown as FontDoc | undefined): Promise<void> {
  if (!doc?.fonts) return
  loadCoupletFont(doc)
  const ready = (sheetReady ?? Promise.resolve()).then(() => doc.fonts!.load(`${px}px "Ma Shan Zheng"`, text)).then(() => undefined)
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, WAIT_MS))
  await Promise.race([ready.catch(() => undefined), timeout])
}

/** 仅测试用：清掉已加载状态 */
export function resetCoupletFontForTest(): void {
  sheetReady = null
}
