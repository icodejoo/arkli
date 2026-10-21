// RC4 加解密：自写 KSA + PRGA，输出 Base64 或十六进制。RC4 已不安全，仅用于兼容与学习

/** 输出编码 */
export type Encoding = 'base64' | 'hex'

/** 状态数组长度 */
const STATE_SIZE = 256
/** 字节掩码 */
const BYTE_MASK = 0xff
/** 密钥不合法的提示 */
const ERR_KEY = '请输入密钥（UTF-8 不超过 256 字节）'

/**
 * RC4 流加密（加解密是同一个运算）。
 *
 * @param key 密钥字节，长度 1~256
 * @param data 待处理字节
 * @returns 处理后的新字节数组
 * @throws RangeError 密钥为空或超过 256 字节
 * @example
 * rc4(utf8Encode('Key'), utf8Encode('Plaintext')) // BB F3 16 E8 D9 40 AF 0A D3
 */
export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  if (key.length < 1 || key.length > STATE_SIZE) throw new RangeError('密钥长度需在 1~256 字节')
  const s = new Uint8Array(STATE_SIZE)
  for (let i = 0; i < STATE_SIZE; i++) s[i] = i
  // KSA：用密钥打乱状态表
  let j = 0
  for (let i = 0; i < STATE_SIZE; i++) {
    j = (j + s[i] + key[i % key.length]) & BYTE_MASK
    const t = s[i]
    s[i] = s[j]
    s[j] = t
  }
  // PRGA：逐字节生成密钥流并异或
  const out = new Uint8Array(data.length)
  let a = 0
  let b = 0
  for (let n = 0; n < data.length; n++) {
    a = (a + 1) & BYTE_MASK
    b = (b + s[a]) & BYTE_MASK
    const t = s[a]
    s[a] = s[b]
    s[b] = t
    out[n] = data[n] ^ s[(s[a] + s[b]) & BYTE_MASK]
  }
  return out
}

/**
 * 字符串转 UTF-8 字节。
 *
 * @param text 文本
 * @returns UTF-8 字节
 * @example
 * utf8Encode('A') // Uint8Array [65]
 */
export function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/**
 * UTF-8 字节转字符串（非法序列会变成替换符）。
 *
 * @param bytes 字节
 * @returns 文本
 * @example
 * utf8Decode(new Uint8Array([65])) // 'A'
 */
export function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

/**
 * 字节转大写十六进制（无分隔）。
 *
 * @param bytes 字节
 * @returns 十六进制串
 * @example
 * bytesToHex(new Uint8Array([0xbb, 0x0f])) // 'BB0F'
 */
export function bytesToHex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s.toUpperCase()
}

/**
 * 十六进制转字节，忽略空白与 `0x` 前缀，大小写不敏感。
 *
 * @param hex 十六进制串
 * @returns 字节；格式不对（含非法字符或位数为奇数）返回 null
 * @example
 * hexToBytes('bb 0f') // Uint8Array [187, 15]
 */
export function hexToBytes(hex: string): Uint8Array | null {
  const h = hex.replace(/\s+/g, '').replace(/^0x/i, '')
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) return null
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * 字节转标准 Base64。
 *
 * @param bytes 字节
 * @returns Base64 串
 * @example
 * bytesToBase64(new Uint8Array([72, 105])) // 'SGk='
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/**
 * Base64 转字节，忽略空白，宽容缺失的填充，兼容 URL 安全字符。
 *
 * @param b64 Base64 串
 * @returns 字节；非法返回 null
 * @example
 * base64ToBytes('SGk') // Uint8Array [72, 105]
 */
export function base64ToBytes(b64: string): Uint8Array | null {
  let s = b64.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null
  s = s.replace(/=+$/, '')
  if (s.length % 4 === 1) return null
  while (s.length % 4) s += '='
  try {
    const bin = atob(s)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

/** 加解密结果：成功带文本，失败带中文提示 */
export type CryptResult = { ok: true; text: string } | { ok: false; error: string }

/** 校验密钥并转字节，不合法返回 null */
function checkKey(key: string): Uint8Array | null {
  const k = utf8Encode(key)
  return k.length >= 1 && k.length <= STATE_SIZE ? k : null
}

/**
 * 加密：UTF-8 文本 → RC4 → 指定编码。
 *
 * @param key 密钥文本（UTF-8，非空）
 * @param plain 明文
 * @param enc 输出编码
 * @returns 密文文本或错误提示
 * @example
 * encryptText('Key', 'Plaintext', 'hex') // { ok: true, text: 'BBF316E8D940AF0AD3' }
 */
export function encryptText(key: string, plain: string, enc: Encoding): CryptResult {
  const k = checkKey(key)
  if (!k) return { ok: false, error: ERR_KEY }
  const out = rc4(k, utf8Encode(plain))
  return { ok: true, text: enc === 'hex' ? bytesToHex(out) : bytesToBase64(out) }
}

/**
 * 解密：按指定编码读入密文 → RC4 → UTF-8 文本。
 *
 * @param key 密钥文本
 * @param cipher 密文（Base64 或十六进制）
 * @param enc 密文编码
 * @returns 明文或错误提示
 * @example
 * decryptText('Key', 'BBF316E8D940AF0AD3', 'hex') // { ok: true, text: 'Plaintext' }
 */
export function decryptText(key: string, cipher: string, enc: Encoding): CryptResult {
  const k = checkKey(key)
  if (!k) return { ok: false, error: ERR_KEY }
  const bytes = enc === 'hex' ? hexToBytes(cipher) : base64ToBytes(cipher)
  if (!bytes) return { ok: false, error: enc === 'hex' ? '密文不是合法的十六进制' : '密文不是合法的 Base64' }
  return { ok: true, text: utf8Decode(rc4(k, bytes)) }
}

/** 持久缓存命名空间 */
export const STORE_NS = 'rc4'
/** 可选方向值 */
export const MODE_VALUES = ['encrypt', 'decrypt'] as const
/** 可选密文编码值 */
export const ENC_VALUES: readonly Encoding[] = ['base64', 'hex']
