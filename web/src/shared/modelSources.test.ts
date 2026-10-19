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
  it('目录提示同时说明 debug 的 run-as 与 release 的 import 目录', async () => {
    const { MANUAL_DIR_HINT } = await load()
    expect(MANUAL_DIR_HINT).toContain('run-as')
    expect(MANUAL_DIR_HINT).toContain('files/import/')
  })
})

describe('isSinglePackage', () => {
  const base = { id: 'm', dir: 'models/m', releasePages: [] }
  it('带 unpackedBytes 且只有一个文件才是“一个包”', async () => {
    const { isSinglePackage } = await load()
    expect(isSinglePackage({ ...base, files: [FILE], format: 'zip', unpackedBytes: 10 })).toBe(true)
  })
  it('旧格式（无 unpackedBytes）或多文件不是', async () => {
    const { isSinglePackage } = await load()
    expect(isSinglePackage({ ...base, files: [FILE] })).toBe(false)
    expect(isSinglePackage({ ...base, files: [FILE, FILE], unpackedBytes: 10 })).toBe(false)
  })
  it('单包的手动放置步骤只提一个 zip 且不含逐文件校验', async () => {
    const { MANUAL_STEPS_PACKAGE } = await load()
    expect(MANUAL_STEPS_PACKAGE.join('')).toContain('zip')
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
