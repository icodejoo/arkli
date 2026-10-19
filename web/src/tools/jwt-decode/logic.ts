// JWT 解析：只解码不验签

/** 时间类声明字段及中文名 */
export const TIME_CLAIMS: ReadonlyArray<{ key: 'exp' | 'iat' | 'nbf'; label: string }> = [
  { key: 'iat', label: '签发时间 iat' },
  { key: 'nbf', label: '生效时间 nbf' },
  { key: 'exp', label: '过期时间 exp' },
]

/** 一条时间声明的解读 */
export interface TimeClaim {
  key: string
  label: string
  /** 秒级时间戳 */
  value: number
  /** 本地时间文本 */
  text: string
}

/** 解析结果 */
export interface JwtParts {
  header: unknown
  payload: unknown
  /** 签名段原文（base64url） */
  signature: string
  times: TimeClaim[]
  /** 有 exp 时：是否已过期 */
  expired: boolean | null
  /** 有 nbf 时：是否尚未生效 */
  notYet: boolean | null
}

/** 解析结果或错误 */
export type JwtResult = { ok: true; value: JwtParts } | { ok: false; error: string }

/**
 * base64url 解码成 UTF-8 文本。
 * @param seg base64url 段
 * @returns 文本；非法字符或非 UTF-8 时抛错
 * @example base64urlDecode('aGk') // 'hi'
 */
export function base64urlDecode(seg: string): string {
  if (!/^[A-Za-z0-9_-]*$/.test(seg)) throw new Error('含非法字符')
  if (seg.length % 4 === 1) throw new Error('长度不合法')
  const b64 = seg.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

/**
 * 秒级时间戳转本地时间文本。
 * @param sec 秒级时间戳
 * @returns yyyy-MM-dd HH:mm:ss
 * @example formatLocal(1700000000)
 */
export function formatLocal(sec: number): string {
  const d = new Date(sec * 1000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 解码某一段为 JSON，失败抛带段名的错 */
function decodeJson(seg: string, name: string): unknown {
  try {
    return JSON.parse(base64urlDecode(seg))
  } catch (e) {
    const why = e instanceof SyntaxError ? '不是合法 JSON' : e instanceof Error && e.message ? e.message : '无法解码'
    throw new Error(`${name} 段解码失败：${why}`)
  }
}

/**
 * 解析 JWT（不验签）。
 * @param token JWT 文本（可带 Bearer 前缀与空白）
 * @param nowMs 当前毫秒时间，默认现在
 * @returns 成功给出各段与时间解读，失败给明确提示
 * @example parseJwt('eyJhbGciOi...') // { ok: true, value: { header, payload, ... } }
 */
export function parseJwt(token: string, nowMs: number = Date.now()): JwtResult {
  const t = token.trim().replace(/^bearer\s+/i, '').replace(/\s+/g, '')
  if (!t) return { ok: false, error: '请粘贴 JWT' }
  const segs = t.split('.')
  if (segs.length !== 3) return { ok: false, error: `JWT 应由 3 段以点号连接，当前是 ${segs.length} 段` }
  try {
    const header = decodeJson(segs[0], 'Header')
    const payload = decodeJson(segs[1], 'Payload')
    const times: TimeClaim[] = []
    const claims = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
    for (const c of TIME_CLAIMS) {
      const v = claims[c.key]
      if (typeof v === 'number' && Number.isFinite(v)) times.push({ key: c.key, label: c.label, value: v, text: formatLocal(v) })
    }
    const nowSec = nowMs / 1000
    const exp = times.find((x) => x.key === 'exp')
    const nbf = times.find((x) => x.key === 'nbf')
    return {
      ok: true,
      value: { header, payload, signature: segs[2], times, expired: exp ? exp.value <= nowSec : null, notYet: nbf ? nbf.value > nowSec : null },
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
