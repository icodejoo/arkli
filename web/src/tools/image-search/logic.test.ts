import { describe, expect, it, vi } from 'vitest'
/** bridge 模块加载时会读 window，node 环境先垫一个空对象 */
vi.hoisted(() => {
  ;(globalThis as Record<string, unknown>).window = {}
})

import { NOTES, SEARCH_SITES, STEPS } from './data'
import { invalidSites, openSite, shareImage, shareName, type OpenDeps, type ShareDeps } from './logic'

/** 构造依赖，可按需覆盖 */
function deps(over: Partial<ShareDeps> = {}): ShareDeps {
  return {
    isNative: () => false,
    writeCache: vi.fn(async () => 'cache/out/a.png'),
    nativeShare: vi.fn(async () => true),
    nav: undefined,
    save: vi.fn(async () => undefined),
    ...over,
  }
}

const blob = new Blob(['x'], { type: 'image/png' })

describe('站点清单', () => {
  it('全部 https，且没有查询串或锚点', () => {
    expect(invalidSites()).toEqual([])
    for (const s of SEARCH_SITES) expect(s.url.startsWith('https://')).toBe(true)
  })
  it('包含要求的五个站点，名称不重复', () => {
    const names = SEARCH_SITES.map((s) => s.name).join('|')
    for (const k of ['Google Lens', 'Bing', '百度', 'TinEye', 'Yandex']) expect(names).toContain(k)
    expect(new Set(SEARCH_SITES.map((s) => s.name)).size).toBe(SEARCH_SITES.length)
  })
  it('invalidSites 能抓出坏地址', () => {
    expect(invalidSites([{ name: 'a', url: 'http://x.com/', note: '' }])).toEqual(['a'])
    expect(invalidSites([{ name: 'b', url: 'https://x.com/?img=1', note: '' }])).toEqual(['b'])
    expect(invalidSites([{ name: 'c', url: 'not a url', note: '' }])).toEqual(['c'])
  })
  it('说明文案非空', () => {
    expect(STEPS.length).toBeGreaterThan(0)
    expect(NOTES.length).toBeGreaterThan(0)
  })
})

describe('shareImage', () => {
  it('容器内：写缓存后调原生分享', async () => {
    const d = deps({ isNative: () => true })
    expect(await shareImage(blob, 'a.png', d)).toBe('shared')
    expect(d.writeCache).toHaveBeenCalledWith(blob, 'a.png')
    expect(d.nativeShare).toHaveBeenCalledWith({ path: 'cache/out/a.png', mime: 'image/png', title: '分享图片' })
    expect(d.save).not.toHaveBeenCalled()
  })
  it('容器内：原生分享没拉起则保存', async () => {
    const d = deps({ isNative: () => true, nativeShare: vi.fn(async () => false) })
    expect(await shareImage(blob, 'a.png', d)).toBe('saved')
    expect(d.save).toHaveBeenCalled()
  })
  it('容器内：写缓存抛错也走保存', async () => {
    const d = deps({ isNative: () => true, writeCache: vi.fn(async () => Promise.reject(new Error('x'))) })
    expect(await shareImage(blob, 'a.png', d)).toBe('saved')
  })
  it('浏览器：支持 Web Share 就用它', async () => {
    const share = vi.fn(async () => undefined)
    const d = deps({ nav: { share, canShare: () => true } as unknown as ShareDeps['nav'] })
    expect(await shareImage(blob, 'a.png', d)).toBe('shared')
    expect(share).toHaveBeenCalled()
    expect(d.save).not.toHaveBeenCalled()
  })
  it('浏览器：用户取消不保存', async () => {
    const err = Object.assign(new Error('cancel'), { name: 'AbortError' })
    const d = deps({ nav: { share: vi.fn(async () => Promise.reject(err)), canShare: () => true } as unknown as ShareDeps['nav'] })
    expect(await shareImage(blob, 'a.png', d)).toBe('cancelled')
    expect(d.save).not.toHaveBeenCalled()
  })
  it('浏览器：不能分享文件则保存', async () => {
    const d = deps({ nav: { share: vi.fn(), canShare: () => false } as unknown as ShareDeps['nav'] })
    expect(await shareImage(blob, 'a.png', d)).toBe('saved')
    expect(d.save).toHaveBeenCalledWith(blob, 'a.png')
  })
  it('浏览器：没有 share 接口则保存', async () => {
    const d = deps({ nav: {} as unknown as ShareDeps['nav'] })
    expect(await shareImage(blob, 'a.png', d)).toBe('saved')
  })
  it('浏览器：分享出其他错误回退保存', async () => {
    const d = deps({ nav: { share: vi.fn(async () => Promise.reject(new Error('boom'))) } as unknown as ShareDeps['nav'] })
    expect(await shareImage(blob, 'a.png', d)).toBe('saved')
  })
})

/** 构造 openSite 的假依赖 */
function openDeps(native: boolean, nativeResult: boolean | Error = true) {
  const nativeOpen = vi.fn(async (_url: string) => {
    if (nativeResult instanceof Error) throw nativeResult
    return nativeResult
  })
  const open = vi.fn((_u: string, _t: string, _f: string) => undefined)
  const deps: OpenDeps = { isNative: () => native, nativeOpen, open }
  return Object.assign(deps, { nativeOpen, open })
}

describe('openSite', () => {
  it('浏览器里 https 地址用新窗口打开', async () => {
    const d = openDeps(false)
    expect(await openSite('https://tineye.com/', d)).toBe(true)
    expect(d.open).toHaveBeenCalledWith('https://tineye.com/', '_blank', 'noopener')
    expect(d.nativeOpen).not.toHaveBeenCalled()
  })
  it('宿主里走原生，不调 window.open', async () => {
    const d = openDeps(true)
    expect(await openSite('https://tineye.com/', d)).toBe(true)
    expect(d.nativeOpen).toHaveBeenCalledWith('https://tineye.com/')
    expect(d.open).not.toHaveBeenCalled()
  })
  it('原生打开失败或抛错返回 false', async () => {
    expect(await openSite('https://tineye.com/', openDeps(true, false))).toBe(false)
    expect(await openSite('https://tineye.com/', openDeps(true, new Error('x')))).toBe(false)
  })
  it('非 https 不打开', async () => {
    const d = openDeps(false)
    expect(await openSite('http://tineye.com/', d)).toBe(false)
    expect(await openSite('javascript:alert(1)', d)).toBe(false)
    expect(d.open).not.toHaveBeenCalled()
  })
})

describe('shareName', () => {
  it('已有扩展名保持不变', () => {
    expect(shareName('a.png', 'image/png')).toBe('a.png')
  })
  it('缺扩展名按 MIME 补，jpeg 记为 jpg', () => {
    expect(shareName('photo', 'image/png')).toBe('photo.png')
    expect(shareName('photo', 'image/jpeg')).toBe('photo.jpg')
    expect(shareName('', '')).toBe('image.jpg')
  })
})
