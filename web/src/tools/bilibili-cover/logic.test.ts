import { describe, expect, it, vi } from 'vitest'

// bridge 在加载时会读 window，node 环境先垫一个空宿主
vi.hoisted(() => {
  ;(globalThis as unknown as { window: unknown }).window = {}
})

import type { NetCallFn } from '@/native/net'
import { buildApiUrl, coverFileName, extractVideoId, fetchCover, normalizePicUrl, parseViewResponse, resolveVideoId } from './logic'

/** 接口成功样例 */
const VIEW_OK = { code: 0, message: '0', data: { bvid: 'BV1xx411c7mD', aid: 170001, title: '标题', pic: 'http://i0.hdslb.com/bfs/archive/a.jpg', owner: { name: 'UP主', mid: 1 } } }

/** 构造 HTTP 响应 */
function http(over: Record<string, unknown>) {
  return { status: 200, statusText: '', url: '', redirects: [], headers: {}, body: '', bodyEncoding: 'text', truncated: false, elapsedMs: 1, ...over }
}

/** 按 URL 返回的假 call */
function router(fn: (url: string, params: Record<string, unknown>) => unknown) {
  const call = vi.fn(async (_m: string, p?: Record<string, unknown>) => fn((p as { url: string }).url, p ?? {}))
  return call as unknown as NetCallFn & typeof call
}

describe('extractVideoId', () => {
  it('BV 号：裸号、链接、带参数、m 站、夹在文字里', () => {
    const bv = { type: 'bvid', id: 'BV1xx411c7mD' }
    expect(extractVideoId('BV1xx411c7mD')).toEqual(bv)
    expect(extractVideoId('bv1xx411c7mD')).toEqual(bv)
    expect(extractVideoId('https://www.bilibili.com/video/BV1xx411c7mD/?p=2&vd_source=abc')).toEqual(bv)
    expect(extractVideoId('https://m.bilibili.com/video/BV1xx411c7mD')).toEqual(bv)
    expect(extractVideoId('【标题】 https://www.bilibili.com/video/BV1xx411c7mD?x=1 分享')).toEqual(bv)
    expect(extractVideoId('看这个BV1xx411c7mD吧')).toEqual(bv)
  })
  it('BV 号长度不对或含非法字符不认', () => {
    expect(extractVideoId('BV1xx411c7m')).toBeNull()
    expect(extractVideoId('BV1xx411c7mDD')).toBeNull()
    expect(extractVideoId('BV0xx411c7mD')).toBeNull()
  })
  it('av 号：裸号、链接、大小写', () => {
    expect(extractVideoId('av170001')).toEqual({ type: 'aid', id: '170001' })
    expect(extractVideoId('AV170001')).toEqual({ type: 'aid', id: '170001' })
    expect(extractVideoId('https://www.bilibili.com/video/av170001?p=1')).toEqual({ type: 'aid', id: '170001' })
    expect(extractVideoId('java17')).toBeNull()
    expect(extractVideoId('170001')).toBeNull()
  })
  it('短链：带不带协议都补成 https', () => {
    expect(extractVideoId('https://b23.tv/AbC123')).toEqual({ type: 'short', url: 'https://b23.tv/AbC123' })
    expect(extractVideoId('【视频】b23.tv/xYz9 复制')).toEqual({ type: 'short', url: 'https://b23.tv/xYz9' })
    expect(extractVideoId('https://bili2233.cn/q1w2')).toEqual({ type: 'short', url: 'https://bili2233.cn/q1w2' })
  })
  it('优先级 BV 高于短链；认不出为 null', () => {
    expect(extractVideoId('https://b23.tv/BV1xx411c7mD')).toEqual({ type: 'bvid', id: 'BV1xx411c7mD' })
    expect(extractVideoId('hello')).toBeNull()
    expect(extractVideoId('')).toBeNull()
  })
})

describe('resolveVideoId', () => {
  it('BV / av 直接返回，不联网', async () => {
    const call = router(() => http({}))
    expect(await resolveVideoId('BV1xx411c7mD', call)).toEqual({ type: 'bvid', id: 'BV1xx411c7mD' })
    expect(call).not.toHaveBeenCalled()
  })
  it('短链：followRedirects 的 GET 取最终地址再提取', async () => {
    const call = router(() => http({ url: 'https://www.bilibili.com/video/BV1xx411c7mD/?share=1' }))
    expect(await resolveVideoId('b23.tv/abc', call)).toEqual({ type: 'bvid', id: 'BV1xx411c7mD' })
    expect(call.mock.calls[0][1]).toMatchObject({ url: 'https://b23.tv/abc', followRedirects: true })
  })
  it('短链没指向视频、输入认不出：抛错', async () => {
    await expect(resolveVideoId('b23.tv/abc', router(() => http({ url: 'https://www.bilibili.com/' })))).rejects.toThrow('没有指向视频')
    await expect(resolveVideoId('乱写', router(() => http({})))).rejects.toThrow('没认出视频')
  })
})

describe('buildApiUrl / normalizePicUrl', () => {
  it('BV 用 bvid，av 用 aid', () => {
    expect(buildApiUrl({ type: 'bvid', id: 'BV1xx411c7mD' })).toBe('https://api.bilibili.com/x/web-interface/view?bvid=BV1xx411c7mD')
    expect(buildApiUrl({ type: 'aid', id: '170001' })).toBe('https://api.bilibili.com/x/web-interface/view?aid=170001')
  })
  it('封面地址升级成 https', () => {
    expect(normalizePicUrl('http://i0.hdslb.com/a.jpg')).toBe('https://i0.hdslb.com/a.jpg')
    expect(normalizePicUrl('//i0.hdslb.com/a.jpg')).toBe('https://i0.hdslb.com/a.jpg')
    expect(normalizePicUrl(' https://i0.hdslb.com/a.jpg ')).toBe('https://i0.hdslb.com/a.jpg')
  })
})

describe('parseViewResponse', () => {
  it('取封面、标题、UP 主，封面升 https', () => {
    expect(parseViewResponse(VIEW_OK)).toEqual({ pic: 'https://i0.hdslb.com/bfs/archive/a.jpg', title: '标题', owner: 'UP主', bvid: 'BV1xx411c7mD', aid: '170001' })
  })
  it('缺 owner / title 给空串', () => {
    expect(parseViewResponse({ code: 0, data: { pic: '//a/b.jpg' } })).toMatchObject({ title: '', owner: '', pic: 'https://a/b.jpg' })
  })
  it('接口错误码转中文', () => {
    expect(() => parseViewResponse({ code: -404, message: '啥都木有' })).toThrow('视频不存在')
    expect(() => parseViewResponse({ code: -799, message: '请求过于频繁' })).toThrow('请求过于频繁')
  })
  it('没有封面或乱结构抛错', () => {
    expect(() => parseViewResponse({ code: 0, data: {} })).toThrow('没有返回封面')
    expect(() => parseViewResponse(null)).toThrow('没有返回封面')
  })
})

describe('coverFileName', () => {
  it('按类型取扩展名，没有 BV 号用 av 号', () => {
    const info = { pic: '', title: '', owner: '', bvid: 'BV1xx411c7mD', aid: '1' }
    expect(coverFileName(info, 'image/png')).toBe('BV1xx411c7mD.png')
    expect(coverFileName(info, 'image/webp; q=1')).toBe('BV1xx411c7mD.webp')
    expect(coverFileName(info)).toBe('BV1xx411c7mD.jpg')
    expect(coverFileName({ ...info, bvid: '' })).toBe('av1.jpg')
    expect(coverFileName({ ...info, bvid: '', aid: '' })).toBe('bilibili-cover.jpg')
  })
})

describe('fetchCover', () => {
  it('识别 → 查接口 → 下载封面', async () => {
    const call = router((url) => {
      if (url.startsWith('https://api.bilibili.com/')) return http({ body: JSON.stringify(VIEW_OK) })
      return http({ body: 'aGk=', bodyEncoding: 'base64', headers: { 'content-type': 'image/jpeg' } })
    })
    const r = await fetchCover('BV1xx411c7mD', call)
    expect(r.info.title).toBe('标题')
    expect(r.blob.size).toBe(2)
    expect(r.contentType).toBe('image/jpeg')
    expect(call.mock.calls[0][1]).toMatchObject({ url: 'https://api.bilibili.com/x/web-interface/view?bvid=BV1xx411c7mD' })
    expect(call.mock.calls[1][1]).toMatchObject({ url: 'https://i0.hdslb.com/bfs/archive/a.jpg', responseType: 'base64' })
  })
  it('接口报错时不去下封面', async () => {
    const call = router(() => http({ body: JSON.stringify({ code: -404, message: 'x' }) }))
    await expect(fetchCover('BV1xx411c7mD', call)).rejects.toThrow('视频不存在')
    expect(call).toHaveBeenCalledTimes(1)
  })
})
