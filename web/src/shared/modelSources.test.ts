import { afterEach, describe, expect, it, vi } from 'vitest'

type Mod = typeof import('./modelSources')

/** 先桩好 window（bridge 导入时会读它）再加载被测模块；withHost 为 true 时带原生宿主 */
async function load(withHost = false, open: unknown = vi.fn(() => ({}))): Promise<Mod> {
  vi.resetModules()
  vi.stubGlobal('window', { open, ...(withHost ? { ArkliNative: { postMessage: vi.fn(), onmessage: null } } : {}) })
  return import('./modelSources')
}

const FILE = { name: 'a.bin', bytes: 1, sha256: 'ab', urls: ['https://x/1', 'https://x/2'] }

afterEach(() => vi.unstubAllGlobals())

describe('canDownload', () => {
  it('未安装、未校验、损坏可下载；下载中与已安装不可', async () => {
    const { canDownload } = await load()
    expect(canDownload('absent')).toBe(true)
    expect(canDownload('unverified')).toBe(true)
    expect(canDownload('corrupt')).toBe(true)
    expect(canDownload('downloading')).toBe(false)
    expect(canDownload('installed')).toBe(false)
  })
})

describe('文本拼装', () => {
  it('manualDirText 去掉首尾斜杠', async () => {
    const { manualDirText } = await load()
    expect(manualDirText('models/a')).toBe('files/models/a/')
    expect(manualDirText('/models/a/')).toBe('files/models/a/')
  })
  it('fileCopyText 含名字、sha256 与全部地址', async () => {
    const { fileCopyText } = await load()
    expect(fileCopyText(FILE)).toBe('a.bin\nsha256: ab\nhttps://x/1\nhttps://x/2')
  })
  it('allFirstUrls 每文件取首个地址，跳过无地址的', async () => {
    const { allFirstUrls } = await load()
    expect(allFirstUrls([FILE, { ...FILE, urls: [] }])).toBe('https://x/1')
  })
  it('说明步骤非空', async () => {
    const { MANUAL_STEPS } = await load()
    expect(MANUAL_STEPS.length).toBeGreaterThan(0)
  })
})

describe('openLink', () => {
  it('无宿主：走 window.open', async () => {
    const open = vi.fn(() => ({}))
    const { openLink } = await load(false, open)
    expect(await openLink('https://x/1')).toBe(true)
    expect(open).toHaveBeenCalledWith('https://x/1', '_blank', 'noopener')
  })
  it('无宿主且被拦截：false', async () => {
    const { openLink } = await load(false, vi.fn(() => null))
    expect(await openLink('https://x/1')).toBe(false)
  })
})

describe('footerOf 弹窗底部按钮', () => {
  it('未安装与损坏：下载', async () => {
    const { footerOf } = await load()
    expect(footerOf('absent')).toEqual({ primary: 'download', verify: false })
    expect(footerOf('corrupt')).toEqual({ primary: 'download', verify: false })
  })
  it('已安装：删除；未校验：删除 + 校验', async () => {
    const { footerOf } = await load()
    expect(footerOf('installed')).toEqual({ primary: 'remove', verify: false })
    expect(footerOf('unverified')).toEqual({ primary: 'remove', verify: true })
  })
  it('下载中：置灰', async () => {
    const { footerOf } = await load()
    expect(footerOf('downloading')).toEqual({ primary: 'downloading', verify: false })
  })
})
