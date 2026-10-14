import { describe, expect, it } from 'vitest'
import {
  AUDIO_OUT_MIME, audioCodecName, checkAudio, formatDuration, isCancelled, isWhole, MIN_SPAN_MS, msgOf, normalizeRange, percentOf, rangeLabel,
  sliderStep, SUPPORTED_AUDIO_MIME, toRequest,
} from './logic'

describe('formatDuration', () => {
  it('分秒与时分秒', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(65_000)).toBe('1:05')
    expect(formatDuration(3_723_000)).toBe('1:02:03')
    expect(formatDuration(59_999)).toBe('0:59')
  })
  it('负数与非数字按 0', () => {
    expect(formatDuration(-5)).toBe('0:00')
    expect(formatDuration(NaN)).toBe('0:00')
  })
})

describe('sliderStep', () => {
  it('短视频 100ms，长视频 1 秒', () => {
    expect(sliderStep(60_000)).toBe(100)
    expect(sliderStep(600_000)).toBe(100)
    expect(sliderStep(600_001)).toBe(1000)
  })
})

describe('normalizeRange', () => {
  it('颠倒的区间自动对调', () => {
    expect(normalizeRange([8000, 3000], 10_000)).toEqual({ startMs: 3000, endMs: 8000 })
  })
  it('夹在 0~总时长', () => {
    expect(normalizeRange([-5, 99_999], 10_000)).toEqual({ startMs: 0, endMs: 10_000 })
  })
  it('起止太近时向后撑开，贴着结尾时向前撑开', () => {
    expect(normalizeRange([1000, 1000], 10_000)).toEqual({ startMs: 1000, endMs: 1000 + MIN_SPAN_MS })
    expect(normalizeRange([10_000, 10_000], 10_000)).toEqual({ startMs: 10_000 - MIN_SPAN_MS, endMs: 10_000 })
  })
  it('总时长比最小间隔还短时取整段', () => {
    expect(normalizeRange([0, 0], 50)).toEqual({ startMs: 0, endMs: 50 })
  })
})

describe('isWhole / toRequest', () => {
  it('整段什么都不传', () => {
    expect(isWhole({ startMs: 0, endMs: 10_000 }, 10_000)).toBe(true)
    expect(toRequest({ startMs: 0, endMs: 10_000 }, 10_000)).toEqual({})
  })
  it('只裁一头只传那一头', () => {
    expect(toRequest({ startMs: 0, endMs: 5000 }, 10_000)).toEqual({ endMs: 5000 })
    expect(toRequest({ startMs: 2000, endMs: 10_000 }, 10_000)).toEqual({ startMs: 2000 })
    expect(toRequest({ startMs: 2000.4, endMs: 5000.6 }, 10_000)).toEqual({ startMs: 2000, endMs: 5001 })
    expect(isWhole({ startMs: 2000, endMs: 10_000 }, 10_000)).toBe(false)
  })
})

describe('rangeLabel', () => {
  it('带总长', () => {
    expect(rangeLabel({ startMs: 3000, endMs: 8000 })).toBe('0:03 – 0:08（共 0:05）')
  })
})

describe('checkAudio', () => {
  it('没有音轨', () => {
    expect(checkAudio({ hasAudio: false, audioMime: null })).toEqual({ ok: false, text: '这个视频没有音轨' })
  })
  it('AAC 可提取', () => {
    expect(checkAudio({ hasAudio: true, audioMime: SUPPORTED_AUDIO_MIME })).toEqual({ ok: true, text: 'AAC' })
  })
  it('编码未知时放行，由原生判断', () => {
    expect(checkAudio({ hasAudio: true, audioMime: null }).ok).toBe(true)
  })
  it('其他编码不支持并说明', () => {
    const r = checkAudio({ hasAudio: true, audioMime: 'audio/amr-wb' })
    expect(r.ok).toBe(false)
    expect(r.text).toContain('amr-wb')
    expect(r.text).toContain('AAC')
  })
  it('产物 mime 固定，编码短名', () => {
    expect(AUDIO_OUT_MIME).toBe('audio/mp4')
    expect(audioCodecName('audio/opus')).toBe('opus')
    expect(audioCodecName(null)).toBe('未知编码')
  })
})

describe('percentOf', () => {
  it('夹在 0~100', () => {
    expect(percentOf({ done: 50, total: 200 })).toBe(25)
    expect(percentOf({ done: 300, total: 200 })).toBe(100)
    expect(percentOf({ done: -1, total: 200 })).toBe(0)
    expect(percentOf({ done: 1, total: 0 })).toBe(0)
  })
})

describe('错误辅助', () => {
  it('msgOf 与 isCancelled', () => {
    expect(msgOf(new Error('出错了'), '兜底')).toBe('出错了')
    expect(msgOf(null, '兜底')).toBe('兜底')
    expect(isCancelled({ code: 'CANCELLED' })).toBe(true)
    expect(isCancelled(new Error('x'))).toBe(false)
    expect(isCancelled(null)).toBe(false)
  })
})
