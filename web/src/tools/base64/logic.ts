// Base64 编解码：UTF-8 文本，支持 URL 安全变体、去填充、宽容解码

/** 输入字符数上限（约 2MB），再大容易卡住 WebView */
export const MAX_INPUT_CHARS = 2_000_000

/** 编码时每块处理的字节数，避免 String.fromCharCode 参数过多 */
const CHUNK = 0x8000

/** 标准 Base64 字符集（含填充符）的合法性检查 */
const STD_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

/** data URL 前缀，如 `data:image/png;base64,` */
const DATA_URL_PREFIX = /^data:[^,]*;base64,/i

/** 操作结果：成功带值，失败带中文提示 */
export type Base64Result = { ok: true; value: string } | { ok: false; error: string }

/** 编码选项 */
export interface EncodeOptions {
  /** 使用 URL 安全字符集（- 和 _ 代替 + 和 /） */
  urlSafe?: boolean
  /** 是否保留末尾 `=` 填充，默认保留 */
  padding?: boolean
}

/** 超限提示 */
const TOO_LARGE: Base64Result = { ok: false, error: '内容太大了（超过约 2MB），请分段处理' }

/**
 * 把文本按 UTF-8 编码成 Base64。
 *
 * @param text 原文
 * @param opts 编码选项
 * @returns 成功返回 Base64 串；超大输入返回错误
 * @example
 * encodeText('你好') // { ok: true, value: '5L2g5aW9' }
 */
export function encodeText(text: string, opts: EncodeOptions = {}): Base64Result {
  if (text.length > MAX_INPUT_CHARS) return TOO_LARGE
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  let out = btoa(bin)
  if (opts.urlSafe) out = out.replace(/\+/g, '-').replace(/\//g, '_')
  if (opts.padding === false) out = out.replace(/=+$/, '')
  return { ok: true, value: out }
}

/**
 * 解码 Base64 为 UTF-8 文本。宽容处理：自动剥 data URL 前缀、忽略空白与换行、
 * 同时接受标准与 URL 安全字符集、缺少填充时自动补齐。
 *
 * @param input Base64 串
 * @returns 成功返回文本；非法字符、长度不对、解出来不是 UTF-8 文本时返回错误
 * @example
 * decodeText('5L2g5aW9') // { ok: true, value: '你好' }
 */
export function decodeText(input: string): Base64Result {
  if (input.length > MAX_INPUT_CHARS) return TOO_LARGE
  const cleaned = input
    .trim()
    .replace(DATA_URL_PREFIX, '')
    .replace(/\s+/g, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/')
  if (!STD_PATTERN.test(cleaned)) return { ok: false, error: '含有 Base64 不允许的字符' }
  const body = cleaned.replace(/=+$/, '')
  if (body.length % 4 === 1) return { ok: false, error: '长度不对，可能少了字符' }
  const padded = body + '='.repeat((4 - (body.length % 4)) % 4)
  let bin: string
  try {
    bin = atob(padded)
  } catch {
    return { ok: false, error: '不是合法的 Base64' }
  }
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  try {
    return { ok: true, value: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  } catch {
    return { ok: false, error: '解码成功，但内容不是 UTF-8 文本（可能是图片等二进制数据）' }
  }
}
