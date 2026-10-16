import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FONT_CSS_URL, loadCoupletFont, resetCoupletFontForTest, waitCoupletFont, type FontDoc } from './font'

/** 造一个假文档，记录注入的 link；fire 控制 link 的加载结果 */
function fakeDoc(fire: 'load' | 'error' | 'none', fonts?: FontDoc['fonts']) {
  const links: Array<ReturnType<FontDoc['createElement']>> = []
  const doc: FontDoc = {
    getElementById: (id) => links.find((l) => l.id === id) ?? null,
    createElement: () => ({ id: '', rel: '', href: '', onload: null, onerror: null }),
    head: {
      appendChild: (el) => {
        const l = el as ReturnType<FontDoc['createElement']>
        links.push(l)
        if (fire === 'load') queueMicrotask(() => l.onload?.())
        if (fire === 'error') queueMicrotask(() => l.onerror?.())
        return el
      },
    },
    fonts,
  }
  return { doc, links }
}

beforeEach(() => resetCoupletFontForTest())

describe('loadCoupletFont', () => {
  it('只注入一次样式表，指向 Google Fonts', () => {
    const { doc, links } = fakeDoc('none')
    loadCoupletFont(doc)
    loadCoupletFont(doc)
    expect(links).toHaveLength(1)
    expect(links[0].href).toBe(FONT_CSS_URL)
    expect(links[0].rel).toBe('stylesheet')
  })
  it('没有 document 时静默跳过', () => {
    expect(() => loadCoupletFont(undefined)).not.toThrow()
  })
})

describe('waitCoupletFont', () => {
  it('样式表和字体都就绪后返回', async () => {
    const load = vi.fn().mockResolvedValue([])
    const { doc } = fakeDoc('load', { load })
    await waitCoupletFont('春风', 32, doc)
    expect(load).toHaveBeenCalledWith('32px "Ma Shan Zheng"', '春风')
  })
  it('没网（样式表加载失败、字体加载抛错）也不抛错', async () => {
    const { doc } = fakeDoc('error', { load: () => Promise.reject(new Error('offline')) })
    await expect(waitCoupletFont('春风', 32, doc)).resolves.toBeUndefined()
  })
  it('没有字体集 API 的旧环境直接返回', async () => {
    const { doc } = fakeDoc('none')
    await expect(waitCoupletFont('春风', 32, doc)).resolves.toBeUndefined()
  })
  it('一直等不到就超时放行', async () => {
    vi.useFakeTimers()
    const { doc } = fakeDoc('none', { load: () => new Promise(() => {}) })
    const p = waitCoupletFont('春风', 32, doc)
    await vi.advanceTimersByTimeAsync(3100)
    await expect(p).resolves.toBeUndefined()
    vi.useRealTimers()
  })
})
