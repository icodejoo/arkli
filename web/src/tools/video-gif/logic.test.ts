import { describe, expect, it } from 'vitest'
import {
  adviceFor, CAPTURE_SHARE, clampDuration, delayCs, estimateGifBytes, frameCount, frameUrl, gifFileName, isCancelled, makePlan, MAX_FRAMES,
  maxStartMs, msgOf, overallPercent, scaleSize, WARN_GIF_BYTES,
} from './logic'

describe('clampDuration', () => {
  it('夹在 0.5~15 秒', () => {
    expect(clampDuration(0, 100, 60_000)).toBe(500)
    expect(clampDuration(0, 99_000, 60_000)).toBe(15_000)
    expect(clampDuration(0, 3000, 60_000)).toBe(3000)
  })
  it('不超出起点之后剩余的长度', () => {
    expect(clampDuration(8000, 9000, 10_000)).toBe(2000)
    expect(clampDuration(0, 3000, 300)).toBe(300)
    expect(clampDuration(11_000, 3000, 10_000)).toBe(0)
  })
})

describe('maxStartMs', () => {
  it('保证还能取满时长', () => {
    expect(maxStartMs(10_000, 3000)).toBe(7000)
    expect(maxStartMs(2000, 3000)).toBe(0)
  })
})

describe('scaleSize', () => {
  it('按最大边缩小并保持比例', () => {
    expect(scaleSize(1920, 1080, 320)).toEqual({ width: 320, height: 180 })
    expect(scaleSize(1080, 1920, 320)).toEqual({ width: 180, height: 320 })
  })
  it('不放大', () => {
    expect(scaleSize(200, 100, 320)).toEqual({ width: 200, height: 100 })
  })
  it('极端比例至少 1 像素', () => {
    expect(scaleSize(10_000, 1, 320)).toEqual({ width: 320, height: 1 })
  })
})

describe('frameCount', () => {
  it('与原生时间表一致', () => {
    expect(frameCount(0, 3000, 8, 10_000)).toBe(24)
    expect(frameCount(0, 1000, 7, 10_000)).toBe(7)
    expect(frameCount(0, 1000, 4, 10_000)).toBe(4)
  })
  it('不超出视频结尾', () => {
    expect(frameCount(1000, 5000, 2, 2000)).toBe(2)
    expect(frameCount(5000, 1000, 8, 2000)).toBe(0)
  })
  it('最多 150 帧', () => {
    expect(frameCount(0, 15_000, 15, 60_000)).toBe(MAX_FRAMES)
  })
})

describe('delayCs', () => {
  it('帧率换算成 1/100 秒', () => {
    expect(delayCs(10)).toBe(10)
    expect(delayCs(5)).toBe(20)
    expect(delayCs(8)).toBe(13)
    expect(delayCs(15)).toBe(7)
    expect(delayCs(1000)).toBe(2)
  })
})

describe('体积预估与方案', () => {
  it('帧数 × 像素 × 经验系数', () => {
    expect(estimateGifBytes(24, 320, 180)).toBe(Math.round(24 * 320 * 180 * 0.5))
  })
  it('makePlan 综合起点、尺寸与时间表', () => {
    const p = makePlan({ startMs: 0, durationMs: 3000, fps: 8, maxEdge: 320, totalMs: 10_000, srcWidth: 1920, srcHeight: 1080 })
    expect(p).toEqual({ frames: 24, width: 320, height: 180, bytes: estimateGifBytes(24, 320, 180) })
  })
})

describe('adviceFor', () => {
  it('正常方案没有提示', () => {
    expect(adviceFor({ frames: 24, width: 320, height: 180, bytes: 1_000_000 })).toEqual([])
  })
  it('没有帧', () => {
    expect(adviceFor({ frames: 0, width: 320, height: 180, bytes: 0 })[0]).toContain('超出视频长度')
  })
  it('体积偏大', () => {
    expect(adviceFor({ frames: 50, width: 480, height: 270, bytes: WARN_GIF_BYTES + 1 }).some((t) => t.includes('体积偏大'))).toBe(true)
  })
  it('帧数多与到上限', () => {
    const many = adviceFor({ frames: 100, width: 100, height: 100, bytes: 1 })
    expect(many.some((t) => t.includes('比较慢'))).toBe(true)
    const full = adviceFor({ frames: MAX_FRAMES, width: 100, height: 100, bytes: 1 })
    expect(full.some((t) => t.includes('最多取'))).toBe(true)
  })
})

describe('overallPercent', () => {
  it('取帧占前 40%，编码占后 60%', () => {
    expect(overallPercent('capture', 0, 10)).toBe(0)
    expect(overallPercent('capture', 10, 10)).toBe(CAPTURE_SHARE)
    expect(overallPercent('encode', 0, 10)).toBe(CAPTURE_SHARE)
    expect(overallPercent('encode', 5, 10)).toBe(70)
    expect(overallPercent('encode', 10, 10)).toBe(100)
  })
  it('异常值夹住', () => {
    expect(overallPercent('encode', 20, 10)).toBe(100)
    expect(overallPercent('capture', 1, 0)).toBe(0)
  })
})

describe('文件名与地址', () => {
  it('换成 .gif', () => {
    expect(gifFileName('旅行.mp4')).toBe('旅行.gif')
    expect(gifFileName('a.b.mov')).toBe('a.b.gif')
    expect(gifFileName('x:y.mp4')).toBe('x_y.gif')
    expect(gifFileName('')).toBe('video.gif')
    expect(gifFileName('noext')).toBe('noext.gif')
  })
  it('取帧地址带同源前缀', () => {
    expect(frameUrl('cache/out/frames-ab/f000.jpg')).toBe('/files/cache/out/frames-ab/f000.jpg')
    expect(frameUrl('/cache/x.jpg')).toBe('/files/cache/x.jpg')
  })
})

describe('错误辅助', () => {
  it('msgOf 与 isCancelled', () => {
    expect(msgOf(new Error('坏了'), '兜底')).toBe('坏了')
    expect(msgOf(undefined, '兜底')).toBe('兜底')
    expect(isCancelled({ code: 'CANCELLED' })).toBe(true)
    expect(isCancelled({})).toBe(false)
  })
})
