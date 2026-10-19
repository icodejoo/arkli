import { describe, expect, it, vi } from 'vitest'

describe('shareApp', () => {
  it('先导出本应用安装包，再带文案、路径与 APK 类型分享', async () => {
    vi.stubGlobal('window', {})
    const { APK_MIME, APP_SHARE_FILE_NAME, APP_SHARE_TEXT, APP_SHARE_TITLE, shareApp } = await import('./appShare')
    const send = vi.fn().mockResolvedValue(true)
    const exporter = vi.fn().mockResolvedValue({ path: 'cache/out/a.apk', name: 'a.apk', bytes: 1 })
    expect(await shareApp(send, exporter)).toBe(true)
    expect(exporter).toHaveBeenCalledWith('self', APP_SHARE_FILE_NAME)
    expect(send).toHaveBeenCalledWith({ text: APP_SHARE_TEXT, path: 'cache/out/a.apk', mime: APK_MIME, title: APP_SHARE_TITLE })
  })

  it('分享链接只发文字，内容含下载地址，并带 logo 缩略图', async () => {
    vi.stubGlobal('window', {})
    const { APP_DOWNLOAD_URL, APP_SHARE_LINK_TEXT, APP_SHARE_TITLE, shareAppLink } = await import('./appShare')
    const send = vi.fn().mockResolvedValue(true)
    const icon = vi.fn().mockResolvedValue('cache/out/i.png')
    expect(await shareAppLink(send, icon)).toBe(true)
    expect(APP_SHARE_LINK_TEXT).toContain(APP_DOWNLOAD_URL)
    expect(icon).toHaveBeenCalledWith('self', 192)
    expect(send).toHaveBeenCalledWith({ text: APP_SHARE_LINK_TEXT, title: APP_SHARE_TITLE, thumb: 'cache/out/i.png' })
  })

  it('取图标失败时照常分享，只是不带缩略图', async () => {
    vi.stubGlobal('window', {})
    const { APP_SHARE_LINK_TEXT, APP_SHARE_TITLE, shareAppLink } = await import('./appShare')
    const send = vi.fn().mockResolvedValue(true)
    expect(await shareAppLink(send, () => Promise.reject(new Error('x')))).toBe(true)
    expect(send).toHaveBeenCalledWith({ text: APP_SHARE_LINK_TEXT, title: APP_SHARE_TITLE, thumb: undefined })
  })
})
