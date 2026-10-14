import { describe, expect, it } from 'vitest'
import type { WallpaperFail } from '@/native/wallpaper'
import { ALTERNATIVE_TIP, describeFailure, describeOk, wallpaperFileName } from './logic'

/** 造一个失败结果 */
function fail(reason: string): WallpaperFail {
  return { available: false, reason: reason as WallpaperFail['reason'], message: '' }
}

describe('describeFailure', () => {
  it('restricted 说明 Android 13 的限制', () => {
    const c = describeFailure(fail('restricted'))
    expect(c.title).toContain('不让')
    expect(c.detail).toContain('Android 13')
  })
  it('unsupported / error 各有说明', () => {
    expect(describeFailure(fail('unsupported')).title).toContain('不支持')
    expect(describeFailure(fail('error')).title).toContain('失败')
  })
  it('未知原因按 error 处理', () => {
    expect(describeFailure(fail('weird')).title).toBe(describeFailure(fail('error')).title)
  })
  it('替代做法提到相册', () => {
    expect(ALTERNATIVE_TIP).toContain('相册')
  })
})

describe('describeOk / wallpaperFileName', () => {
  it('区分当前与默认壁纸', () => {
    expect(describeOk({ available: true, path: 'p', width: 1080, height: 2400, kind: 'current' })).toBe('当前壁纸 · 1080×2400')
    expect(describeOk({ available: true, path: 'p', width: 1, height: 2, kind: 'default' })).toContain('默认')
  })
  it('文件名带时间戳并补零', () => {
    const d = new Date(2026, 0, 2, 3, 4, 5)
    expect(wallpaperFileName('current', d)).toBe('wallpaper-20260102-030405.png')
    expect(wallpaperFileName('default', d)).toBe('wallpaper-default-20260102-030405.png')
  })
})
