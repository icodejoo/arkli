// 联网搜索源：Brave 网页搜索（主）+ 维基百科（兜底），都经原生 net.http 发请求
import { netHttp } from '@/native/net'

/** 一条搜索结果 */
export interface SearchHit {
  /** 标题 */
  title: string
  /** 网址 */
  url: string
  /** 摘要或正文片段 */
  text: string
}

/** 发请求函数的类型（测试可注入） */
export type HttpFn = typeof netHttp

/** 中日韩字符判断 */
const CJK = /[㐀-鿿]/
/** Brave 网页搜索地址（HTML 页，免 Key） */
const BRAVE_URL = 'https://search.brave.com/search'
/** 每次最多取几条网页结果 */
const WEB_LIMIT = 5
/** 维基接口的最长摘要字数 */
const WIKI_EXTRACT_CHARS = 600
/** 维基每次搜索取几条 */
const WIKI_LIMIT = 3
/** 命名实体的解码表（够用即可，不引入解码库） */
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'" }
/** 一条网页结果块的起点：Brave 用 data-type="web" 标出自然结果，类名里的哈希会变，所以只认语义属性 */
const BRAVE_BLOCK = /<div class="snippet[^"]*"[^>]*data-type="web"/g
/** 取块里第一个外链（结果标题的链接） */
const BRAVE_HREF = /<a[^>]*href="(https?:\/\/[^"]+)"/
/** 取标题：class 含 search-snippet-title 的元素 */
const BRAVE_TITLE = /class="[^"]*search-snippet-title[^"]*"[^>]*>([\s\S]*?)<\/div>/
/** 取摘要：generic-snippet 里的 content 元素 */
const BRAVE_DESC = /generic-snippet[\s\S]*?class="content[^"]*"[^>]*>([\s\S]*?)<\/div>/

/**
 * 去标签、解码常见实体、折叠空白。
 *
 * @param html 一小段 HTML
 * @returns 纯文本
 * @example htmlToText('<b>a</b>&nbsp;&amp;b') // 'a &b'
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, name: string) => {
      const key = name.toLowerCase()
      if (ENTITIES[key] !== undefined) return ENTITIES[key]
      const code = key.startsWith('#x') ? parseInt(key.slice(2), 16) : key.startsWith('#') ? parseInt(key.slice(1), 10) : NaN
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    })
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 解析 Brave 搜索结果页：只取自然网页结果，标题或网址缺失的块丢掉。
 *
 * @param html 结果页 HTML
 * @param limit 条数上限
 * @returns 搜索结果（摘要可能为空）
 * @example parseBraveResults(html, 5)
 */
export function parseBraveResults(html: string, limit: number): SearchHit[] {
  const starts = [...html.matchAll(BRAVE_BLOCK)].map((m) => m.index as number)
  const out: SearchHit[] = []
  for (let i = 0; i < starts.length && out.length < limit; i++) {
    const block = html.slice(starts[i], starts[i + 1] ?? html.length)
    const url = BRAVE_HREF.exec(block)?.[1]
    const title = htmlToText(BRAVE_TITLE.exec(block)?.[1] ?? '')
    if (!url || !title) continue
    out.push({ title, url: htmlToText(url), text: htmlToText(BRAVE_DESC.exec(block)?.[1] ?? '') })
  }
  return out
}

/**
 * Brave 网页搜索：任意话题，不限站点。结果页是 HTML，靠语义属性解析；改版后解析会拿到空，由上层兜底。
 *
 * @param query 关键词
 * @param signal 取消信号，可选
 * @param http 发请求函数，默认走原生桥（测试可注入）
 * @returns 搜索结果，没有则为空数组
 * @example const hits = await braveSearch('量子计算有什么用')
 */
export async function braveSearch(query: string, signal?: AbortSignal, http: HttpFn = netHttp): Promise<SearchHit[]> {
  const params = new URLSearchParams({ q: query, source: 'web' })
  const r = await http({ url: `${BRAVE_URL}?${params}` }, undefined, signal)
  return parseBraveResults(r.body, WEB_LIMIT)
}

/**
 * 维基百科搜索（官方 API，JSON，免 Key、免解析网页）：一次调用同时拿标题与导语纯文本。
 * 含中文的关键词查中文站，否则查英文站。
 *
 * @param query 关键词
 * @param signal 取消信号，可选
 * @param http 发请求函数，默认走原生桥（测试可注入）
 * @returns 搜索结果，按相关度排序
 * @example const hits = await wikiSearch('量子计算')
 */
export async function wikiSearch(query: string, signal?: AbortSignal, http: HttpFn = netHttp): Promise<SearchHit[]> {
  const lang = CJK.test(query) ? 'zh' : 'en'
  const params = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: query,
    gsrlimit: String(WIKI_LIMIT),
    prop: 'extracts',
    exintro: '1',
    explaintext: '1',
    exchars: String(WIKI_EXTRACT_CHARS),
    redirects: '1',
    format: 'json',
    formatversion: '2',
  })
  const r = await http({ url: `https://${lang}.wikipedia.org/w/api.php?${params}` }, undefined, signal)
  const pages: { index: number; title: string; extract?: string }[] = JSON.parse(r.body)?.query?.pages ?? []
  return pages
    .filter((p) => p.extract)
    .sort((a, b) => a.index - b.index)
    .map((p) => ({ title: p.title, url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.title)}`, text: p.extract as string }))
}

/**
 * 通用网页搜索：先 Brave（任意话题），失败或没结果再退到维基百科。被取消时直接抛出，不兜底。
 *
 * @param query 关键词
 * @param signal 取消信号，可选
 * @param http 发请求函数，默认走原生桥（测试可注入）
 * @returns 搜索结果
 * @example const hits = await webSearch('今天的比特币价格')
 */
export async function webSearch(query: string, signal?: AbortSignal, http: HttpFn = netHttp): Promise<SearchHit[]> {
  try {
    const hits = await braveSearch(query, signal, http)
    if (hits.length) return hits
  } catch (e) {
    if (signal?.aborted) throw e
  }
  return wikiSearch(query, signal, http)
}
