/**
 * 图片转 Base64 的纯逻辑：data URL 解析、Base64 宽容解码、体积与膨胀率、魔数嗅探。
 * 不碰 DOM，可直接单测。
 */

/** 大图提示阈值：5MB */
export const LARGE_BYTES = 5 * 1024 * 1024

/** 超过此长度的文本提示复制可能失败：500KB */
export const BIG_TEXT_CHARS = 500 * 1024

/** data URL 前缀正则：捕获 MIME 和参数段 */
const DATA_URL_RE = /^data:([^;,]*)((?:;[^;,]*)*),/i

/** Base64 字符集（标准）校验 */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/

/** 解析结果 */
export interface ParsedBase64 {
  /** data URL 里声明的 MIME，纯 Base64 时为空串 */
  mime: string
  /** 规整后的标准 Base64（已补齐 =） */
  base64: string
}

/**
 * 规整 Base64：去空白、URL 安全字符转标准字符、补齐 `=`。
 *
 * @param text 原始 Base64 文本
 * @returns 标准 Base64
 * @example normalizeBase64('YW Jj\n') // 'YWJj'
 */
export function normalizeBase64(text: string): string {
  const s = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  const pad = (4 - (s.length % 4)) % 4
  // 长度模 4 余 1 的串无法补齐，原样返回交给校验报错
  return pad === 3 ? s : s + '='.repeat(pad)
}

/**
 * 校验是否为合法的标准 Base64（长度为 4 的倍数且字符合法，不能为空）。
 *
 * @param base64 已规整的 Base64
 * @returns 合法为 true
 */
export function isValidBase64(base64: string): boolean {
  return base64.length > 0 && base64.length % 4 === 0 && BASE64_RE.test(base64)
}

/**
 * 解析用户粘贴的内容：支持完整 data URL，也支持纯 Base64；带空白换行也能识别。
 *
 * @param text 粘贴的文本
 * @returns 解析结果；内容不是合法 Base64 时返回 null
 * @example parseBase64Input('data:image/png;base64,iVBOR') // { mime: 'image/png', base64: 'iVBOR===' 之类 }
 */
export function parseBase64Input(text: string): ParsedBase64 | null {
  const trimmed = text.trim()
  let mime = ''
  let body = trimmed
  const m = DATA_URL_RE.exec(trimmed)
  if (m) {
    mime = m[1].toLowerCase()
    body = trimmed.slice(m[0].length)
  }
  const base64 = normalizeBase64(body)
  return isValidBase64(base64) ? { mime, base64 } : null
}

/**
 * 去掉 data URL 前缀，只留 Base64 部分；不是 data URL 时原样返回。
 *
 * @param dataUrl data URL
 * @returns 纯 Base64
 * @example stripDataUrlPrefix('data:image/png;base64,AAA') // 'AAA'
 */
export function stripDataUrlPrefix(dataUrl: string): string {
  const m = DATA_URL_RE.exec(dataUrl)
  return m ? dataUrl.slice(m[0].length) : dataUrl
}

/**
 * 拼 data URL。
 *
 * @param mime 图片 MIME
 * @param base64 纯 Base64
 * @example buildDataUrl('image/png', 'AAA') // 'data:image/png;base64,AAA'
 */
export function buildDataUrl(mime: string, base64: string): string {
  return `data:${mime};base64,${base64}`
}

/**
 * 由 Base64 长度反推原始字节数（含 `=` 填充的扣除）。
 *
 * @param base64 标准 Base64
 * @returns 原始字节数
 * @example decodedSize('YWJj') // 3
 */
export function decodedSize(base64: string): number {
  if (!base64) return 0
  let pad = 0
  if (base64.endsWith('==')) pad = 2
  else if (base64.endsWith('=')) pad = 1
  return Math.floor((base64.length * 3) / 4) - pad
}

/**
 * 原始字节数对应的 Base64 字符数。
 *
 * @param bytes 原始字节数
 * @example encodedLength(3) // 4
 */
export function encodedLength(bytes: number): number {
  return Math.ceil(bytes / 3) * 4
}

/**
 * 膨胀率文案：编码后比原文件大多少，如 `+33%`。
 *
 * @param rawBytes 原文件字节数
 * @param textChars 输出文本字符数
 * @returns 百分比文案；原文件为 0 时返回 `--`
 * @example bloatText(300, 400) // '+33%'
 */
export function bloatText(rawBytes: number, textChars: number): string {
  if (rawBytes <= 0) return '--'
  const pct = Math.round(((textChars - rawBytes) / rawBytes) * 100)
  return pct >= 0 ? `+${pct}%` : `${pct}%`
}

/**
 * 标准 Base64 转字节。调用前请先用 isValidBase64 校验。
 *
 * @param base64 标准 Base64
 * @returns 字节数组
 * @example base64ToBytes('YWJj') // Uint8Array [97, 98, 99]
 */
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(base64)
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** 魔数表：开头字节与 MIME 的对应 */
const MAGIC: Array<{ mime: string; head: number[] }> = [
  { mime: 'image/png', head: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/jpeg', head: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', head: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/bmp', head: [0x42, 0x4d] },
]

/**
 * 按文件头魔数嗅探图片 MIME，支持 PNG/JPEG/GIF/BMP/WebP。
 *
 * @param bytes 文件开头字节
 * @returns MIME；认不出返回空串
 * @example sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])) // 'image/jpeg'
 */
export function sniffImageMime(bytes: Uint8Array): string {
  for (const { mime, head } of MAGIC) {
    if (bytes.length >= head.length && head.every((b, i) => bytes[i] === b)) return mime
  }
  // WebP：RIFF....WEBP
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') {
    return 'image/webp'
  }
  return ''
}
