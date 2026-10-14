import { describe, expect, it } from 'vitest'
import {
  buildStitchParams,
  checkOverwrite,
  confirmText,
  filesUrl,
  FORMAT_UNSUPPORTED_HINT,
  DEFAULT_FORMAT,
  PNG_SLOW_HINT,
  PNG_SLOW_PIXELS,
  pngSlowHint,
  pngCompressMaxEdge,
  PNG_COMPRESS_MAX_PIXELS,
  stitchPercent,
  formatOfMime,
  outputsToDiscard,
  overwriteErrorText,
  type StitchOptions,
} from './logic'

/** 默认选项 */
const opts: StitchOptions = { direction: 'v', gap: 10, bg: '#ffffff', align: 'center', unify: true, format: 'png' }

describe('buildStitchParams', () => {
  it('PNG 不带质量', () => {
    const p = buildStitchParams(['a', 'b'], opts)
    expect(p).toEqual({ items: [{ path: 'a' }, { path: 'b' }], direction: 'v', gap: 10, bg: '#ffffff', align: 'center', unify: true, format: 'png' })
  })
  it('JPEG 带质量，间距夹到 0~200 并取整', () => {
    const p = buildStitchParams(['a', 'b'], { ...opts, format: 'jpeg', gap: 999.6 })
    expect(p.quality).toBe(0.92)
    expect(p.gap).toBe(200)
    expect(buildStitchParams(['a'], { ...opts, gap: -3 }).gap).toBe(0)
  })
})

describe('formatOfMime', () => {
  it('归一 png / jpeg，其余为 null', () => {
    expect(formatOfMime('image/PNG')).toBe('png')
    expect(formatOfMime('image/jpg')).toBe('jpeg')
    expect(formatOfMime('image/jpeg')).toBe('jpeg')
    expect(formatOfMime('image/webp')).toBeNull()
    expect(formatOfMime(undefined)).toBeNull()
  })
})

describe('checkOverwrite', () => {
  it('没有图或无句柄：隐藏', () => {
    expect(checkOverwrite(undefined, 'png').visible).toBe(false)
    expect(checkOverwrite({ mime: 'image/png' }, 'png').visible).toBe(false)
  })
  it('格式一致：可用', () => {
    expect(checkOverwrite({ mime: 'image/jpeg', sourceHandle: 'h' }, 'jpeg')).toEqual({ visible: true, disabled: false, hint: '' })
  })
  it('格式不一致或原图非 png/jpeg：禁用并提示', () => {
    expect(checkOverwrite({ mime: 'image/jpeg', sourceHandle: 'h' }, 'png')).toEqual({
      visible: true,
      disabled: true,
      hint: '原图是 JPEG，请把输出格式切到 JPEG',
    })
    expect(checkOverwrite({ mime: 'image/png', sourceHandle: 'h' }, 'jpeg').hint).toBe('原图是 PNG，请把输出格式切到 PNG')
    expect(checkOverwrite({ mime: 'image/webp', sourceHandle: 'h' }, 'png')).toEqual({
      visible: true,
      disabled: true,
      hint: FORMAT_UNSUPPORTED_HINT,
    })
  })
})

describe('overwriteErrorText', () => {
  it('各错误码映射成人话', () => {
    expect(overwriteErrorText({ code: 'FORMAT_MISMATCH', message: 'x' })).toBe('格式与原图不同，请把输出格式改成一致')
    expect(overwriteErrorText({ code: 'PERMISSION_DENIED', message: 'x' })).toBe('未获得修改授权')
    expect(overwriteErrorText({ code: 'NOT_READY', message: '覆盖原图需要 Android 11 及以上' })).toBe('需要 Android 11 及以上')
    expect(overwriteErrorText({ code: 'NOT_READY', message: '正在等待授权' })).toBe('正在等待授权')
    expect(overwriteErrorText({ code: 'BAD_PARAMS', message: 'handle 无效或已过期，请重新选择原图' })).toBe('原图句柄已失效，请重新选择图片')
    expect(overwriteErrorText({ code: 'BAD_PARAMS', message: 'path 无效' })).toBe('path 无效')
    expect(overwriteErrorText({ code: 'INTERNAL', message: '无法读取原图' })).toBe('覆盖失败：无法读取原图')
    expect(overwriteErrorText(null)).toBe('覆盖失败')
  })
})

describe('其它', () => {
  it('确认文案含当前文件名', () => {
    expect(confirmText('a.jpg')).toBe('将覆盖第一张原图 a.jpg，不可撤销')
  })
  it('outputsToDiscard 去空去重', () => {
    expect(outputsToDiscard('a', undefined, 'a', 'b')).toEqual(['a', 'b'])
  })
  it('filesUrl 加前缀', () => {
    expect(filesUrl('cache/out/a.png')).toBe('/files/cache/out/a.png')
  })
})

describe('默认格式与 PNG 慢提示', () => {
  it('默认 JPEG', () => {
    expect(DEFAULT_FORMAT).toBe('jpeg')
  })
  it('只有 PNG 且像素超阈值才提示', () => {
    expect(pngSlowHint('png', 5000, 4001)).toBe(PNG_SLOW_HINT)
    expect(pngSlowHint('png', 5000, 4000)).toBe('')
    expect(pngSlowHint('jpeg', 9000, 9000)).toBe('')
    expect(PNG_SLOW_PIXELS).toBe(20_000_000)
  })
  it('PNG 成品超 1600 万像素时给出缩放用的最长边，其余为 0', () => {
    expect(pngCompressMaxEdge('png', 4000, 4000)).toBe(0)
    expect(pngCompressMaxEdge('jpeg', 9000, 9000)).toBe(0)
    const edge = pngCompressMaxEdge('png', 8000, 4000)
    expect(edge).toBeGreaterThan(0)
    expect(edge).toBeLessThan(8000)
    expect(edge * Math.ceil((edge * 4000) / 8000)).toBeLessThanOrEqual(PNG_COMPRESS_MAX_PIXELS)
  })
})

describe('stitchPercent', () => {
  it('draw 阶段按 done/total', () => {
    expect(stitchPercent({ phase: 'draw', done: 1, total: 4 }, 0)).toBe(25)
  })
  it('encode 阶段把 percent 折进去', () => {
    expect(stitchPercent({ phase: 'encode', done: 3, total: 4, percent: 0 }, 0)).toBe(75)
    expect(stitchPercent({ phase: 'encode', done: 3, total: 4, percent: 50 }, 0)).toBe(87)
    expect(stitchPercent({ phase: 'encode', done: 3, total: 4, percent: 100 }, 0)).toBe(100)
  })
  it('JPEG 只有一条 percent:100 的 encode 事件', () => {
    expect(stitchPercent({ phase: 'encode', done: 2, total: 3, percent: 100 }, 0)).toBe(100)
  })
  it('done 阶段满格；缺 phase 的旧事件兼容', () => {
    expect(stitchPercent({ phase: 'done', done: 5, total: 5 }, 90)).toBe(100)
    expect(stitchPercent({ done: 1, total: 2 }, 0)).toBe(50)
  })
  it('只增不减，坏事件保持原值', () => {
    expect(stitchPercent({ done: 1, total: 4 }, 60)).toBe(60)
    expect(stitchPercent(null, 40)).toBe(40)
    expect(stitchPercent({ done: 1, total: 0 }, 7)).toBe(7)
  })
})
