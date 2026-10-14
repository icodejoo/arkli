// WiFi 二维码：按 WIFI: 约定拼接 payload，转义特殊字符；二维码本身复用 qrcode-gen 的生成与绘制

/** 加密类型 */
export type WifiAuth = 'WPA' | 'WEP' | 'nopass'

/** 加密类型选项 */
export const AUTH_OPTIONS: ReadonlyArray<{ id: WifiAuth; label: string }> = [
  { id: 'WPA', label: 'WPA/WPA2/WPA3' },
  { id: 'WEP', label: 'WEP' },
  { id: 'nopass', label: '无密码' },
]

/** SSID 最长字节数（802.11 规定 32 字节） */
export const SSID_MAX_BYTES = 32
/** WPA 密码最短长度 */
export const WPA_PASS_MIN = 8
/** WPA 密码最长长度 */
export const WPA_PASS_MAX = 63
/** 需要加反斜杠转义的字符 */
const SPECIAL_RE = /([\\;,:"])/g
/** 纯十六进制串（SSID 长这样时要加引号，免得被当成十六进制 SSID） */
const HEX_RE = /^[0-9a-fA-F]+$/

/** 表单输入 */
export interface WifiInput {
  /** 网络名 */
  ssid: string
  /** 密码，无密码时忽略 */
  password: string
  /** 加密类型 */
  auth: WifiAuth
  /** 是否隐藏网络 */
  hidden: boolean
}

/**
 * 转义 WIFI 二维码里的特殊字符 `\ ; , : "`，前面各加一个反斜杠。
 *
 * @param s 原始字符串
 * @returns 转义后的字符串
 * @example escapeWifi('a;b') // 'a\\;b'
 */
export function escapeWifi(s: string): string {
  return s.replace(SPECIAL_RE, '\\$1')
}

/** 估算 UTF-8 字节数（不依赖 TextEncoder） */
function utf8Length(s: string): number {
  let n = 0
  for (const ch of s) {
    const c = ch.codePointAt(0) as number
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
  }
  return n
}

/**
 * 校验输入，返回第一条错误。
 *
 * @param input 表单输入
 * @returns 错误提示；通过返回空串
 * @example validateWifi({ ssid: '', password: '', auth: 'WPA', hidden: false }) // '请输入 WiFi 名称'
 */
export function validateWifi(input: WifiInput): string {
  if (!input.ssid) return '请输入 WiFi 名称'
  if (utf8Length(input.ssid) > SSID_MAX_BYTES) return `WiFi 名称最长 ${SSID_MAX_BYTES} 字节（一个汉字占 3 字节）`
  if (input.auth === 'WPA') {
    const n = input.password.length
    if (n < WPA_PASS_MIN || n > WPA_PASS_MAX) return `WPA 密码需要 ${WPA_PASS_MIN}~${WPA_PASS_MAX} 位`
  }
  if (input.auth === 'WEP' && !input.password) return '请输入 WEP 密码'
  return ''
}

/**
 * 构造 WIFI 二维码内容，如 `WIFI:T:WPA;S:name;P:pass;H:false;;`。
 *
 * @param input 表单输入（调用前请先 validateWifi）
 * @returns payload 字符串；无密码时省略 P 字段
 * @example buildWifiPayload({ ssid: 'home', password: '12345678', auth: 'WPA', hidden: false })
 * // 'WIFI:T:WPA;S:home;P:12345678;H:false;;'
 */
export function buildWifiPayload(input: WifiInput): string {
  const ssid = HEX_RE.test(input.ssid) ? `"${escapeWifi(input.ssid)}"` : escapeWifi(input.ssid)
  let s = `WIFI:T:${input.auth};S:${ssid};`
  if (input.auth !== 'nopass') s += `P:${escapeWifi(input.password)};`
  return `${s}H:${input.hidden ? 'true' : 'false'};;`
}
