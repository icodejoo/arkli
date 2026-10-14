import { beforeAll, describe, expect, it, vi } from 'vitest'

type Mod = typeof import('./aiImage')
type AiMod = typeof import('@/native/ai')
let aiErrorText: Mod['aiErrorText']
let resolveImagePath: Mod['resolveImagePath']
let AiNotReadyError: AiMod['AiNotReadyError']

// bridge 在导入时就读 window，node 环境先垫一个空对象
beforeAll(async () => {
  vi.stubGlobal('window', {})
  ;({ aiErrorText, resolveImagePath } = await import('./aiImage'))
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
