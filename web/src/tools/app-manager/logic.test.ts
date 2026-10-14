import { describe, expect, it, vi } from 'vitest'
import type { AppInfo } from '@/native/apps'
import { createIconLoader, createLimiter, filterApps, formatBytes, formatDateTime, sortApps, summarize } from './logic'

/** 造应用，只关心要测的字段 */
function app(pkg: string, label: string, p: Partial<AppInfo> = {}): AppInfo {
  return { pkg, label, versionName: '1.0', versionCode: 1, firstInstallMs: 0, lastUpdateMs: 0, isSystem: false, apkBytes: 0, ...p }
}

const APPS = [
  app('com.tencent.mm', '微信', { firstInstallMs: 300, apkBytes: 200 }),
  app('com.android.settings', '设置', { isSystem: true, firstInstallMs: 100, apkBytes: 50 }),
  app('com.example.Notes', 'Notes', { firstInstallMs: 200, apkBytes: 500 }),
  app('com.alipay', 'Alipay', { firstInstallMs: 200, apkBytes: 500 }),
]

describe('filterApps', () => {
  it('默认隐藏系统应用', () => {
    expect(filterApps(APPS, '', false).map((a) => a.pkg)).not.toContain('com.android.settings')
    expect(filterApps(APPS, '', true)).toHaveLength(4)
  })
  it('按应用名或包名搜，不分大小写，多词要全部命中', () => {
    expect(filterApps(APPS, '微信', true).map((a) => a.pkg)).toEqual(['com.tencent.mm'])
    expect(filterApps(APPS, 'NOTES', true).map((a) => a.pkg)).toEqual(['com.example.Notes'])
    expect(filterApps(APPS, 'com.tencent', true)).toHaveLength(1)
    expect(filterApps(APPS, 'com 微信', true)).toHaveLength(1)
    expect(filterApps(APPS, 'com 不存在', true)).toHaveLength(0)
    expect(filterApps(APPS, '   ', true)).toHaveLength(4)
  })
  it('搜索词命中系统应用也要看开关', () => {
    expect(filterApps(APPS, '设置', false)).toHaveLength(0)
    expect(filterApps(APPS, '设置', true)).toHaveLength(1)
  })
})

describe('sortApps', () => {
  it('安装时间新的在前，并列按名称', () => {
    expect(sortApps(APPS, 'installed').map((a) => a.pkg)).toEqual(['com.tencent.mm', 'com.alipay', 'com.example.Notes', 'com.android.settings'])
  })
  it('大小大的在前，并列按名称', () => {
    expect(sortApps(APPS, 'size').map((a) => a.pkg)).toEqual(['com.alipay', 'com.example.Notes', 'com.tencent.mm', 'com.android.settings'])
  })
  it('名称排序稳定：同名按包名', () => {
    const list = [app('b.b', 'X'), app('a.a', 'X')]
    expect(sortApps(list, 'name').map((a) => a.pkg)).toEqual(['a.a', 'b.b'])
  })
  it('不改原数组', () => {
    const copy = APPS.slice()
    sortApps(APPS, 'size')
    expect(APPS).toEqual(copy)
  })
})

describe('格式化', () => {
  it('formatBytes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-1)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(23.4 * 1024 * 1024)).toBe('23.4 MB')
    expect(formatBytes(150 * 1024 * 1024)).toBe('150 MB')
    expect(formatBytes(1.2 * 1024 ** 3)).toBe('1.20 GB')
  })
  it('formatDateTime', () => {
    expect(formatDateTime(new Date(2026, 9, 3, 7, 5).getTime())).toBe('2026-10-03 07:05')
    expect(formatDateTime(0)).toBe('未知')
    expect(formatDateTime(NaN)).toBe('未知')
  })
  it('summarize', () => {
    expect(summarize([app('a.a', 'A', { apkBytes: 1024 }), app('b.b', 'B', { apkBytes: 1024 })])).toBe('共 2 个应用，安装包合计 2.0 KB')
  })
})

describe('createLimiter', () => {
  it('同时运行的任务不超过上限，且都能完成', async () => {
    const run = createLimiter(3)
    let running = 0
    let peak = 0
    const gates: Array<() => void> = []
    const results = Array.from({ length: 8 }, (_, i) =>
      run(
        () =>
          new Promise<number>((resolve) => {
            running++
            peak = Math.max(peak, running)
            gates.push(() => {
              running--
              resolve(i)
            })
          }),
      ),
    )
    expect(peak).toBe(3)
    while (gates.length) {
      gates.shift()!()
      await Promise.resolve()
      await Promise.resolve()
    }
    expect(await Promise.all(results)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(peak).toBe(3)
  })
  it('任务失败不堵队列，错误原样抛给调用方', async () => {
    const run = createLimiter(1)
    const bad = run(() => Promise.reject(new Error('x')))
    const ok = run(async () => 'fine')
    await expect(bad).rejects.toThrow('x')
    expect(await ok).toBe('fine')
  })
  it('并发上限至少为 1', async () => {
    const run = createLimiter(0)
    expect(await run(async () => 1)).toBe(1)
  })
})

describe('createIconLoader', () => {
  it('同包只请求一次，结果缓存', async () => {
    const load = vi.fn(async (pkg: string) => `/files/${pkg}.png`)
    const icons = createIconLoader(load)
    const [a, b] = await Promise.all([icons.get('a.a'), icons.get('a.a')])
    expect(a).toBe('/files/a.a.png')
    expect(b).toBe(a)
    await icons.get('a.a')
    expect(load).toHaveBeenCalledTimes(1)
  })
  it('失败得到 null 且不再重试', async () => {
    const load = vi.fn(async () => {
      throw new Error('no icon')
    })
    const icons = createIconLoader(load)
    expect(await icons.get('a.a')).toBeNull()
    expect(await icons.get('a.a')).toBeNull()
    expect(load).toHaveBeenCalledTimes(1)
  })
  it('并发不超过 3', async () => {
    let running = 0
    let peak = 0
    const load = vi.fn(async (pkg: string) => {
      running++
      peak = Math.max(peak, running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      return pkg
    })
    const icons = createIconLoader(load)
    await Promise.all(Array.from({ length: 10 }, (_, i) => icons.get(`p.${i}`)))
    expect(peak).toBe(3)
    expect(load).toHaveBeenCalledTimes(10)
  })
})
