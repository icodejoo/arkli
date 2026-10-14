// 二维码识别：结果整理、码种中文名、网址判断（纯逻辑）
import type { QrResult } from '@/native/qrcode'

/** 码种名称（zxing-cpp 枚举名）对应的中文说明，没收录的原样显示 */
const FORMAT_LABELS: Record<string, string> = {
  QR_CODE: '二维码',
  MICRO_QR_CODE: '微型二维码',
  RMQR_CODE: '矩形二维码',
  DATA_MATRIX: 'Data Matrix',
  AZTEC: 'Aztec 码',
  PDF_417: 'PDF417',
  MAXI_CODE: 'MaxiCode',
  EAN_13: 'EAN-13 条码',
  EAN_8: 'EAN-8 条码',
  UPC_A: 'UPC-A 条码',
  UPC_E: 'UPC-E 条码',
  CODE_128: 'Code 128 条码',
  CODE_39: 'Code 39 条码',
  CODE_93: 'Code 93 条码',
  ITF: 'ITF 条码',
  CODABAR: 'Codabar 条码',
}

/** 能直接打开的网址协议 */
const URL_RE = /^https?:\/\/\S+$/i

/**
 * 码种名称转展示名。
 *
 * @param format 枚举名，如 `QR_CODE`
 * @returns 中文名；没收录时返回原名
 * @example formatLabel('QR_CODE') // '二维码'
 */
export function formatLabel(format: string): string {
  return FORMAT_LABELS[format] ?? format
}

/**
 * 是否是可打开的网址（只认 http/https，且整段文本没有空白）。
 *
 * @param text 识别文本
 * @returns 是则 true
 * @example isOpenableUrl('https://a.com') // true
 */
export function isOpenableUrl(text: string): boolean {
  return URL_RE.test(text.trim())
}

/**
 * 合并多批结果并去重：同码种同内容只留第一个，保持出现顺序。
 *
 * @param batches 若干批识别结果
 * @returns 合并去重后的列表
 * @example mergeResults([a], [a, b]) // [a, b]
 */
export function mergeResults(...batches: QrResult[][]): QrResult[] {
  const seen = new Set<string>()
  const out: QrResult[] = []
  for (const r of batches.flat()) {
    const key = `${r.format}|${r.bytes || r.text}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}

/**
 * 结果的展示文本：文本为空（纯二进制内容）时给出提示，免得显示成空白。
 *
 * @param r 识别结果
 * @returns 可直接展示的文本
 * @example displayText({ text: '', format: 'QR_CODE', bytes: 'AA==' }) // '（二进制内容，无法显示为文本）'
 */
export function displayText(r: QrResult): string {
  return r.text === '' ? '（二进制内容，无法显示为文本）' : r.text
}
