import { describe, expect, it } from 'vitest'
import {
  buildParams,
  capabilities,
  clampInt,
  defaultOptions,
  describeFailed,
  isBigger,
  progressText,
  resultNote,
  roomLeft,
  type CompressOptions,
} from './logic'

/** 一个输入 */
const ITEMS = [{ path: 'cache/pick/a.jpg', name: 'a.jpg' }]

/** 在默认选项上改字段 */
function opts(over: Partial<CompressOptions>): CompressOptions {
  return { ...defaultOptions(), ...over }
}

describe('buildParams', () => {
  it('默认 jpeg 只带 items/format/quality', () => {
    expect(buildParams(ITEMS, opts({}))).toEqual({
      items: [{ path: 'cache/pick/a.jpg', name: 'a.jpg' }],
      format: 'jpeg',
      quality: 80,
    })
  })

  it('最长边 0 不传，非 0 传并夹到下限', () => {
    expect(buildParams(ITEMS, opts({ maxEdge: 0 }))).not.toHaveProperty('maxEdge')
    expect(buildParams(ITEMS, opts({ maxEdge: 1080 }))).toHaveProperty('maxEdge', 1080)
    expect(buildParams(ITEMS, opts({ maxEdge: 10 }))).toHaveProperty('maxEdge', 64)
  })

  it('目标体积：仅 jpeg/webp 且勾选时传，KB 换成字节', () => {
    expect(buildParams(ITEMS, opts({ useTarget: true, targetKb: 200 }))).toHaveProperty('targetBytes', 204800)
    expect(buildParams(ITEMS, opts({ useTarget: false }))).not.toHaveProperty('targetBytes')
    expect(buildParams(ITEMS, opts({ format: 'webp', useTarget: true, targetKb: 1 }))).toHaveProperty('targetBytes', 1024)
    expect(buildParams(ITEMS, opts({ format: 'png', useTarget: true }))).not.toHaveProperty('targetBytes')
  })

  it('png 带 png 字段，缩色才带抖动，颜色数夹范围', () => {
    const lossless = buildParams(ITEMS, opts({ format: 'png', dither: true }))
    expect(lossless.png).toEqual({ mode: 'lossless', colors: 256, dither: false })
    const pal = buildParams(ITEMS, opts({ format: 'png', pngMode: 'palette', colors: 999, dither: true }))
    expect(pal.png).toEqual({ mode: 'palette', colors: 256, dither: true })
    expect((buildParams(ITEMS, opts({ format: 'png', pngMode: 'palette', colors: 1 })).png as { colors: number }).colors).toBe(2)
    expect(buildParams(ITEMS, opts({ format: 'jpeg' }))).not.toHaveProperty('png')
  })

  it('keepExif 仅 jpeg 且勾选时传', () => {
    expect(buildParams(ITEMS, opts({ keepExif: true }))).toHaveProperty('keepExif', true)
    expect(buildParams(ITEMS, opts({ format: 'webp', keepExif: true }))).not.toHaveProperty('keepExif')
    expect(buildParams(ITEMS, opts({ keepExif: false }))).not.toHaveProperty('keepExif')
  })

  it('质量夹到 1~100', () => {
    expect(buildParams(ITEMS, opts({ quality: 0 }))).toHaveProperty('quality', 1)
    expect(buildParams(ITEMS, opts({ quality: 500 }))).toHaveProperty('quality', 100)
  })
})

describe('capabilities', () => {
  it('兜底路径全部置灰', () => {
    expect(capabilities(false, 'jpeg')).toEqual({ pngPalette: false, target: false, exif: false })
  })

  it('原生路径按格式开关', () => {
    expect(capabilities(true, 'jpeg')).toEqual({ pngPalette: true, target: true, exif: true })
    expect(capabilities(true, 'webp')).toEqual({ pngPalette: true, target: true, exif: false })
    expect(capabilities(true, 'png')).toEqual({ pngPalette: true, target: false, exif: false })
  })
})

describe('resultNote', () => {
  it('变小只写前后体积与比例', () => {
    const s = resultNote(1000, 500)
    expect(s).toContain('压缩前')
    expect(s).not.toContain('比原图大')
  })

  it('变大追加提示', () => {
    expect(resultNote(1000, 1500)).toContain('比原图大')
  })

  it('目标体积未达成追加提示，达成或未设不提示', () => {
    expect(resultNote(1000, 500, false)).toContain('未压到目标体积')
    expect(resultNote(1000, 500, true)).not.toContain('目标')
    expect(resultNote(1000, 500)).not.toContain('目标')
  })
})

describe('其它', () => {
  it('isBigger 边界', () => {
    expect(isBigger(1000, 1000)).toBe(false)
    expect(isBigger(1000, 1001)).toBe(true)
    expect(isBigger(0, 10)).toBe(false)
  })

  it('describeFailed 有名用名，无名用序号', () => {
    expect(describeFailed({ index: 0, name: 'a.jpg', code: 'INTERNAL', message: '无法解码' })).toBe('a.jpg：无法解码（INTERNAL）')
    expect(describeFailed({ index: 2, code: 'BAD_PARAMS', message: 'x' })).toBe('第 3 张：x（BAD_PARAMS）')
  })

  it('progressText 校验形状', () => {
    expect(progressText({ done: 2, total: 5, name: 'a' })).toBe('2/5')
    expect(progressText(null)).toBeNull()
    expect(progressText({ done: '2', total: 5 })).toBeNull()
    expect(progressText({ done: 1, total: 0 })).toBeNull()
  })

  it('clampInt 与 roomLeft', () => {
    expect(clampInt(NaN, 1, 9)).toBe(1)
    expect(clampInt(5.6, 1, 9)).toBe(6)
    expect(roomLeft(10, 20)).toBe(10)
    expect(roomLeft(60, 100)).toBe(0)
    expect(roomLeft(0, 100)).toBe(50)
  })
})
