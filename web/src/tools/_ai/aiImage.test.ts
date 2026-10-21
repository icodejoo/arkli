import { beforeAll, describe, expect, it, vi } from 'vitest'

type Mod = typeof import('./aiImage')
type AiMod = typeof import('@/native/ai')
let aiErrorText: Mod['aiErrorText']
let resolveImagePath: Mod['resolveImagePath']
let handleNotReady: Mod['handleNotReady']
let MSG_TEMP_UNAVAILABLE: Mod['MSG_TEMP_UNAVAILABLE']
let AiNotReadyError: AiMod['AiNotReadyError']

// bridge 在导入时就读 window，node 环境先垫一个空对象
beforeAll(async () => {
  vi.stubGlobal('window', {})
  ;({ aiErrorText, resolveImagePath, handleNotReady, MSG_TEMP_UNAVAILABLE } = await import('./aiImage'))
  ;({ AiNotReadyError } = await import('@/native/ai'))
})

describe('resolveImagePath', () => {
  it('有 path 直接用，不写缓存', async () => {
    const write = vi.fn(async () => 'x')
    expect(await resolveImagePath({ path: 'cache/pick/a.jpg', url: 'u', name: 'a.jpg' }, write)).toBe('cache/pick/a.jpg')
    expect(write).not.toHaveBeenCalled()
  })
  it('没有 path 时读出 Blob 写缓存', async () => {
    const blob = new Blob(['x'])
    const write = vi.fn(async () => 'cache/out/a.jpg')
    const path = await resolveImagePath({ url: 'blob:1', name: 'a.jpg' }, write, async () => blob)
    expect(path).toBe('cache/out/a.jpg')
    expect(write).toHaveBeenCalledWith(blob, 'a.jpg')
  })
})

describe('aiErrorText', () => {
  it('未就绪 / 普通错误 / 无信息', () => {
    expect(aiErrorText(new AiNotReadyError('ocr'))).toBe('模型未就绪')
    expect(aiErrorText(new Error('炸了'))).toBe('处理失败：炸了')
    expect(aiErrorText(null)).toBe('处理失败')
  })
})

describe('handleNotReady', () => {
  it('探测后仍显示就绪：重新探测并弹通用提示，不含下载字样', async () => {
    const refresh = vi.fn(async () => {})
    const toast = vi.fn()
    const prompt = vi.fn(async () => true)
    await handleNotReady(refresh, () => true, toast, prompt)
    expect(prompt).not.toHaveBeenCalled()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(toast).toHaveBeenCalledWith(MSG_TEMP_UNAVAILABLE)
    expect(MSG_TEMP_UNAVAILABLE).not.toMatch(/下载|校验/)
  })
  it('探测后已不就绪：弹「没有可用模型」对话框，不弹 toast', async () => {
    const toast = vi.fn()
    const prompt = vi.fn(async () => true)
    await handleNotReady(async () => {}, () => false, toast, prompt)
    expect(toast).not.toHaveBeenCalled()
    expect(prompt).toHaveBeenCalledTimes(1)
  })
})
