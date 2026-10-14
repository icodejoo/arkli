// B 站封面获取的纯逻辑：提取视频 ID、解析短链、解析接口响应、拉封面
import { httpGetBase64, httpGetJson, netHttp, type NetCallFn } from '@/native/net'

/** 视频信息接口 */
export const VIEW_API = 'https://api.bilibili.com/x/web-interface/view'

/** 请求用的浏览器 UA，B 站接口对默认 UA 偶尔返回 412 */
export const BROWSER_UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36'

/** 短链解析时只需要最终地址，正文最多读这么多字节 */
const SHORT_MAX_BYTES = 1024

/** BV 号：BV + 10 位 base58 字符（不含 0 I O l） */
const BV_RE = /(?:^|[^A-Za-z0-9])[Bb][Vv]([1-9A-HJ-NP-Za-km-z]{10})(?![A-Za-z0-9])/

/** av 号：av + 数字 */
const AV_RE = /(?:^|[^A-Za-z0-9])av(\d{1,12})(?!\d)/i

/** 短链：b23.tv 或 bili2233.cn */
const SHORT_RE = /(?:https?:\/\/)?((?:b23\.tv|bili2233\.cn)\/[A-Za-z0-9]+)/i

/** 内容类型到扩展名 */
const EXT_BY_TYPE: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' }

/** 接口错误码到中文说明 */
const API_ERRORS: Record<number, string> = {
  [-404]: '视频不存在或已被删除',
  [-403]: '没有权限查看这个视频',
  [62002]: '视频不可见',
  [62012]: '视频审核中',
}

/** 提取出的视频标识 */
export type VideoId = { type: 'bvid'; id: string } | { type: 'aid'; id: string } | { type: 'short'; url: string }

/** 已确定的视频标识（不含短链） */
export type ResolvedId = Exclude<VideoId, { type: 'short' }>

/**
 * 从任意文本里提取视频标识，识别 BV 号、av 号、视频链接（含 m 站）与 b23.tv 短链。
 * 优先级 BV > av > 短链；BV 号统一成大写 `BV` 前缀。
 *
 * @param text 用户输入
 * @returns 标识；认不出为 null
 * @example extractVideoId('https://www.bilibili.com/video/BV1xx411c7mD?p=2') // { type: 'bvid', id: 'BV1xx411c7mD' }
 */
export function extractVideoId(text: string): VideoId | null {
  const bv = BV_RE.exec(text)
  if (bv) return { type: 'bvid', id: `BV${bv[1]}` }
  const av = AV_RE.exec(text)
  if (av) return { type: 'aid', id: av[1] }
  const short = SHORT_RE.exec(text)
  if (short) return { type: 'short', url: `https://${short[1]}` }
  return null
}

/**
 * 得到可查询的视频标识：短链先请求一次（自动跟随跳转）取最终地址再提取。
 *
 * @param text 用户输入
 * @param call 原生调用函数，默认走 bridge（测试时注入）
 * @param signal 取消信号
 * @returns BV 或 av 标识；认不出或短链没指向视频时抛错
 * @example const id = await resolveVideoId('https://b23.tv/abc123')
 */
export async function resolveVideoId(text: string, call?: NetCallFn, signal?: AbortSignal): Promise<ResolvedId> {
  const first = extractVideoId(text)
  if (!first) throw new Error('没认出视频：请输入 BV 号、av 号、视频链接或 b23.tv 短链')
  if (first.type !== 'short') return first
  const res = await netHttp({ url: first.url, followRedirects: true, maxBytes: SHORT_MAX_BYTES, headers: { 'user-agent': BROWSER_UA } }, call, signal)
  const next = extractVideoId(res.url)
  if (!next || next.type === 'short') throw new Error('这个短链没有指向视频')
  return next
}

/**
 * 拼视频信息接口地址。
 *
 * @param id 视频标识
 * @returns 接口 URL
 * @example buildApiUrl({ type: 'aid', id: '170001' }) // 'https://api.bilibili.com/x/web-interface/view?aid=170001'
 */
export function buildApiUrl(id: ResolvedId): string {
  return `${VIEW_API}?${id.type === 'bvid' ? 'bvid' : 'aid'}=${encodeURIComponent(id.id)}`
}

/**
 * 把封面地址规范成 https，处理 `//` 开头与 `http://`。
 *
 * @param pic 接口返回的 pic
 * @returns https 地址
 * @example normalizePicUrl('http://i0.hdslb.com/a.jpg') // 'https://i0.hdslb.com/a.jpg'
 */
export function normalizePicUrl(pic: string): string {
  const s = pic.trim()
  if (s.startsWith('//')) return `https:${s}`
  return s.replace(/^http:\/\//i, 'https://')
}

/** 视频基本信息 */
export interface VideoInfo {
  /** 封面地址（https） */
  pic: string
  /** 标题 */
  title: string
  /** UP 主名称 */
  owner: string
  /** BV 号，可能为空 */
  bvid: string
  /** av 号，可能为空 */
  aid: string
}

/**
 * 解析 `/x/web-interface/view` 的响应。
 *
 * @param json 响应 JSON
 * @returns 视频信息；接口返回错误或没有封面时抛带中文原因的 Error
 * @example parseViewResponse({ code: 0, data: { pic: 'http://a/b.jpg', title: 'T', owner: { name: 'U' } } }).pic // 'https://a/b.jpg'
 */
export function parseViewResponse(json: unknown): VideoInfo {
  const j = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>
  if (typeof j.code === 'number' && j.code !== 0) {
    throw new Error(API_ERRORS[j.code] ?? `B 站返回错误（${j.code}）${typeof j.message === 'string' && j.message ? '：' + j.message : ''}`)
  }
  const d = (j.data && typeof j.data === 'object' ? j.data : null) as Record<string, unknown> | null
  if (!d || typeof d.pic !== 'string' || !d.pic) throw new Error('接口没有返回封面')
  const owner = d.owner && typeof d.owner === 'object' ? (d.owner as Record<string, unknown>).name : ''
  return {
    pic: normalizePicUrl(d.pic),
    title: typeof d.title === 'string' ? d.title : '',
    owner: typeof owner === 'string' ? owner : '',
    bvid: typeof d.bvid === 'string' ? d.bvid : '',
    aid: typeof d.aid === 'number' || typeof d.aid === 'string' ? String(d.aid) : '',
  }
}

/**
 * 保存封面用的文件名：`BV号.扩展名`，没有 BV 号用 `av号`。
 *
 * @param info 视频信息
 * @param contentType 封面的 content-type，可空（默认 jpg）
 * @returns 文件名
 * @example coverFileName({ pic: '', title: '', owner: '', bvid: 'BV1xx', aid: '1' }, 'image/webp') // 'BV1xx.webp'
 */
export function coverFileName(info: VideoInfo, contentType = ''): string {
  const base = info.bvid || (info.aid ? `av${info.aid}` : 'bilibili-cover')
  const ext = EXT_BY_TYPE[contentType.split(';')[0].trim().toLowerCase()] ?? 'jpg'
  return `${base}.${ext}`
}

/** 封面获取结果 */
export interface CoverResult {
  /** 视频信息 */
  info: VideoInfo
  /** 封面图片 */
  blob: Blob
  /** 封面 content-type */
  contentType: string
}

/**
 * 完整流程：识别输入 → 查视频信息 → 下载封面。
 *
 * @param text 用户输入
 * @param call 原生调用函数，默认走 bridge（测试时注入）
 * @param signal 取消信号
 * @returns 信息与封面
 * @example const { info, blob } = await fetchCover('BV1xx411c7mD')
 */
export async function fetchCover(text: string, call?: NetCallFn, signal?: AbortSignal): Promise<CoverResult> {
  const id = await resolveVideoId(text, call, signal)
  const headers = { 'user-agent': BROWSER_UA }
  const info = parseViewResponse(await httpGetJson(buildApiUrl(id), call, { headers, signal }))
  const { blob, contentType } = await httpGetBase64(info.pic, call, { signal })
  return { info, blob, contentType }
}
