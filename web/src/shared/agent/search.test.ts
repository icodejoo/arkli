import { describe, expect, it, vi } from 'vitest'
// 真实抓取的 Brave 结果页（精简到 3 条自然结果），防止解析因改版悄悄失效
import BRAVE_FIXTURE from './fixtures/brave-search.html?raw'

/** 带空 window 加载模块（原生桥模块加载时要读 window） */
async function load() {
  vi.stubGlobal('window', {})
  return import('./search')
}

describe('htmlToText', () => {
  it('去标签、解码实体、折叠空白', async () => {
    const { htmlToText } = await load()
    expect(htmlToText('<b>a</b>&nbsp;&amp;  b&#39;s &#x4e2d;<!-- c -->')).toBe("a &  b's 中".replace(/\s+/g, ' '))
  })

  it('不认识的实体原样保留', async () => {
    const { htmlToText } = await load()
    expect(htmlToText('x &foo; y')).toBe('x &foo; y')
  })
})

describe('parseBraveResults', () => {
  it('从真实页面取出标题、网址与摘要', async () => {
    const { parseBraveResults } = await load()
    const hits = parseBraveResults(BRAVE_FIXTURE, 5)
    expect(hits).toHaveLength(3)
    expect(hits[0].url).toBe('https://www.ibm.com/think/topics/quantum-computing')
    expect(hits[0].title).toContain('Quantum Computing')
    expect(hits[1].title).toContain('量子计算')
    for (const h of hits) {
      expect(h.url).toMatch(/^https:\/\//)
      expect(h.title).not.toMatch(/[<>]/)
      expect(h.text).not.toMatch(/<[a-z]/i)
    }
    expect(hits.some((h) => h.text.length > 20)).toBe(true)
  })

  it('按上限截断，空页面返回空', async () => {
    const { parseBraveResults } = await load()
    expect(parseBraveResults(BRAVE_FIXTURE, 2)).toHaveLength(2)
    expect(parseBraveResults('<html></html>', 5)).toEqual([])
  })
})

describe('braveSearch', () => {
  it('请求 Brave 并解析', async () => {
    const { braveSearch } = await load()
    const http = vi.fn().mockResolvedValue({ body: BRAVE_FIXTURE })
    const hits = await braveSearch('量子 计算', undefined, http as never)
    expect(http.mock.calls[0][0].url).toContain('https://search.brave.com/search?q=')
    expect(hits.length).toBeGreaterThan(0)
  })
})

describe('wikiSearch', () => {
  it('中文关键词查中文站，按 index 排序并过滤空摘要', async () => {
    const { wikiSearch } = await load()
    const body = JSON.stringify({
      query: { pages: [{ index: 2, title: 'B', extract: 'bb' }, { index: 1, title: 'A', extract: 'aa' }, { index: 3, title: 'C' }] },
    })
    const http = vi.fn().mockResolvedValue({ body })
    const hits = await wikiSearch('量子', undefined, http as never)
    expect(http.mock.calls[0][0].url).toContain('https://zh.wikipedia.org/w/api.php?')
    expect(hits.map((h) => h.title)).toEqual(['A', 'B'])
    expect(hits[0].url).toBe('https://zh.wikipedia.org/wiki/A')
  })

  it('英文关键词查英文站', async () => {
    const { wikiSearch } = await load()
    const http = vi.fn().mockResolvedValue({ body: '{}' })
    expect(await wikiSearch('quantum', undefined, http as never)).toEqual([])
    expect(http.mock.calls[0][0].url).toContain('https://en.wikipedia.org/')
  })
})

describe('webSearch', () => {
  /** 按网址分流的假 http：Brave 返回 brave，其它返回 wiki */
  function fakeHttp(brave: () => Promise<{ body: string }>) {
    const wikiBody = JSON.stringify({ query: { pages: [{ index: 1, title: 'W', extract: 'w' }] } })
    return vi.fn((p: { url: string }) => (p.url.includes('brave.com') ? brave() : Promise.resolve({ body: wikiBody })))
  }

  it('Brave 有结果就用 Brave', async () => {
    const { webSearch } = await load()
    const http = fakeHttp(async () => ({ body: BRAVE_FIXTURE }))
    const hits = await webSearch('量子', undefined, http as never)
    expect(hits[0].url).toContain('ibm.com')
    expect(http).toHaveBeenCalledTimes(1)
  })

  it('Brave 报错或没结果时退到维基', async () => {
    const { webSearch } = await load()
    expect((await webSearch('量子', undefined, fakeHttp(async () => Promise.reject(new Error('net'))) as never))[0].title).toBe('W')
    expect((await webSearch('量子', undefined, fakeHttp(async () => ({ body: '<html></html>' })) as never))[0].title).toBe('W')
  })

  it('被取消时直接抛出，不兜底', async () => {
    const { webSearch } = await load()
    const ac = new AbortController()
    const http = fakeHttp(async () => {
      ac.abort()
      throw new Error('aborted')
    })
    await expect(webSearch('量子', ac.signal, http as never)).rejects.toThrow()
    expect(http).toHaveBeenCalledTimes(1)
  })
})
