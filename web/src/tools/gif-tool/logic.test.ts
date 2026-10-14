import { describe, expect, it } from 'vitest'
import {
  canvasSize,
  checkFrameCount,
  clampMaxEdge,
  csToMs,
  formatSeconds,
  frameFileName,
  isGif,
  MAX_COMPOSE_FRAMES,
  msToCs,
  placeFrame,
  playIndices,
  resolveDelays,
  totalDurationMs,
} from './logic'

describe('msToCs / csToMs', () => {
  it('毫秒四舍五入到厘秒', () => {
    expect(msToCs(200)).toBe(20)
    expect(msToCs(104)).toBe(10)
    expect(msToCs(106)).toBe(11)
  })
  it('小于最小值抬到 2，超大值封顶，非数字回最小值', () => {
    expect(msToCs(0)).toBe(2)
    expect(msToCs(5)).toBe(2)
    expect(msToCs(99999999)).toBe(65535)
    expect(msToCs(NaN)).toBe(2)
  })
  it('厘秒转毫秒，0~1 按浏览器的 100ms', () => {
    expect(csToMs(20)).toBe(200)
    expect(csToMs(0)).toBe(100)
    expect(csToMs(1)).toBe(100)
    expect(csToMs(2)).toBe(20)
  })
})

describe('checkFrameCount', () => {
  it('上限内通过', () => {
    expect(checkFrameCount(MAX_COMPOSE_FRAMES)).toEqual({ ok: true, over: 0 })
  })
  it('超出给出超出数，可自定义上限', () => {
    expect(checkFrameCount(65)).toEqual({ ok: false, over: 5 })
    expect(checkFrameCount(301, 300)).toEqual({ ok: false, over: 1 })
  })
})

describe('clampMaxEdge / canvasSize', () => {
  it('长边上限限制在 64~480', () => {
    expect(clampMaxEdge(1000)).toBe(480)
    expect(clampMaxEdge(10)).toBe(64)
    expect(clampMaxEdge(300.4)).toBe(300)
    expect(clampMaxEdge(NaN)).toBe(480)
  })
  it('按第一张图的比例缩到上限内，小图不放大', () => {
    expect(canvasSize([{ width: 1000, height: 500 }], 480)).toEqual({ width: 480, height: 240 })
    expect(canvasSize([{ width: 100, height: 80 }, { width: 900, height: 900 }], 480)).toEqual({ width: 100, height: 80 })
  })
  it('跳过读不出尺寸的图；没有图为 0x0', () => {
    expect(canvasSize([{ width: 0, height: 0 }, { width: 200, height: 100 }], 100)).toEqual({ width: 100, height: 50 })
    expect(canvasSize([], 480)).toEqual({ width: 0, height: 0 })
  })
})

describe('placeFrame', () => {
  const canvas = { width: 100, height: 100 }
  it('contain：宽图上下留边并居中', () => {
    expect(placeFrame({ width: 200, height: 100 }, canvas, 'contain')).toEqual({ sx: 0, sy: 0, sw: 200, sh: 100, dx: 0, dy: 25, dw: 100, dh: 50 })
  })
  it('contain：高图左右留边', () => {
    expect(placeFrame({ width: 50, height: 100 }, canvas, 'contain')).toMatchObject({ dx: 25, dy: 0, dw: 50, dh: 100 })
  })
  it('contain：小图会放大到贴边', () => {
    expect(placeFrame({ width: 10, height: 10 }, canvas, 'contain')).toMatchObject({ dx: 0, dy: 0, dw: 100, dh: 100 })
  })
  it('cover：裁掉两侧多余部分，铺满画布', () => {
    expect(placeFrame({ width: 200, height: 100 }, canvas, 'cover')).toEqual({ sx: 50, sy: 0, sw: 100, sh: 100, dx: 0, dy: 0, dw: 100, dh: 100 })
  })
  it('stretch：整图拉伸到画布', () => {
    expect(placeFrame({ width: 200, height: 100 }, canvas, 'stretch')).toEqual({ sx: 0, sy: 0, sw: 200, sh: 100, dx: 0, dy: 0, dw: 100, dh: 100 })
  })
  it('源尺寸异常时退回拉伸，不出 NaN', () => {
    const p = placeFrame({ width: 0, height: 0 }, canvas, 'cover')
    expect(Object.values(p).every(Number.isFinite)).toBe(true)
  })
})

describe('playIndices', () => {
  it('正序、倒序', () => {
    expect(playIndices(3, 'normal')).toEqual([0, 1, 2])
    expect(playIndices(3, 'reverse')).toEqual([2, 1, 0])
  })
  it('来回播首尾不重复', () => {
    expect(playIndices(4, 'pingpong')).toEqual([0, 1, 2, 3, 2, 1])
    expect(playIndices(2, 'pingpong')).toEqual([0, 1])
    expect(playIndices(0, 'pingpong')).toEqual([])
  })
})

describe('resolveDelays / totalDurationMs', () => {
  it('统一延迟', () => {
    expect(resolveDelays(3, 100)).toEqual([10, 10, 10])
  })
  it('逐帧延迟缺省回落到统一值', () => {
    expect(resolveDelays(3, 100, [undefined, 500])).toEqual([10, 50, 10])
  })
  it('总时长按浏览器实际行为累计', () => {
    expect(totalDurationMs([10, 20])).toBe(300)
    expect(totalDurationMs([0, 1])).toBe(200)
    expect(totalDurationMs([])).toBe(0)
  })
})

describe('formatSeconds / frameFileName / isGif', () => {
  it('秒数两位小数', () => {
    expect(formatSeconds(1250)).toBe('1.25 秒')
    expect(formatSeconds(0)).toBe('0.00 秒')
  })
  it('帧文件名按总帧数补零', () => {
    expect(frameFileName('anim', 6, 120)).toBe('anim_007.png')
    expect(frameFileName('a', 0, 5)).toBe('a_1.png')
  })
  it('识别 GIF', () => {
    expect(isGif('image/gif', 'x')).toBe(true)
    expect(isGif('', 'A.GIF')).toBe(true)
    expect(isGif('image/png', 'a.png')).toBe(false)
  })
})
