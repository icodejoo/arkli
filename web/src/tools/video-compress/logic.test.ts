import { describe, expect, it } from 'vitest'
import {
  changeText, checkAudioKept, estimateBytes, isCancelled, isNotSmaller, MIN_BITRATE_BPS, msgOf, preWarning, presetOf, PRESETS, sourceVideoBitrate,
  targetBitrate,
} from './logic'

describe('预设', () => {
  it('三档系数与原生一致', () => {
    expect(PRESETS.map((p) => [p.key, p.factor])).toEqual([
      ['high', 0.7],
      ['medium', 0.5],
      ['low', 0.3],
    ])
    expect(presetOf('low').name).toBe('小体积')
  })
})

describe('targetBitrate', () => {
  it('按系数计算', () => {
    expect(targetBitrate(4_000_000, 'high')).toBe(2_800_000)
    expect(targetBitrate(4_000_000, 'medium')).toBe(2_000_000)
    expect(targetBitrate(4_000_000, 'low')).toBe(1_200_000)
  })
  it('有下限，但不超过源码率', () => {
    expect(targetBitrate(800_000, 'low')).toBe(MIN_BITRATE_BPS)
    expect(targetBitrate(200_000, 'low')).toBe(200_000)
    expect(targetBitrate(200_000, 'high')).toBe(200_000)
  })
})

describe('sourceVideoBitrate', () => {
  it('总码率扣音频', () => {
    expect(sourceVideoBitrate({ bitrate: 6_000_000, sizeBytes: null, durationMs: null, hasAudio: true })).toBe(5_872_000)
    expect(sourceVideoBitrate({ bitrate: 6_000_000, sizeBytes: null, durationMs: null, hasAudio: false })).toBe(6_000_000)
  })
  it('总码率缺失时用体积除时长', () => {
    expect(sourceVideoBitrate({ bitrate: null, sizeBytes: 1_000_000, durationMs: 8000, hasAudio: true })).toBe(872_000)
  })
  it('信息不足为 null，扣完过低抬到下限', () => {
    expect(sourceVideoBitrate({ bitrate: null, sizeBytes: null, durationMs: null, hasAudio: true })).toBeNull()
    expect(sourceVideoBitrate({ bitrate: 350_000, sizeBytes: null, durationMs: null, hasAudio: true })).toBe(MIN_BITRATE_BPS)
  })
})

describe('estimateBytes', () => {
  it('(目标视频码率 + 音频) × 时长', () => {
    expect(estimateBytes({ bitrate: 4_128_000, sizeBytes: null, durationMs: 10_000, hasAudio: true }, 'medium')).toBe(2_660_000)
  })
  it('三档依次变小', () => {
    const info = { bitrate: 8_000_000, sizeBytes: null, durationMs: 60_000, hasAudio: true }
    const h = estimateBytes(info, 'high')!
    const m = estimateBytes(info, 'medium')!
    const l = estimateBytes(info, 'low')!
    expect(h).toBeGreaterThan(m)
    expect(m).toBeGreaterThan(l)
  })
  it('时长或码率未知返回 null', () => {
    expect(estimateBytes({ bitrate: 4_000_000, sizeBytes: null, durationMs: null, hasAudio: true }, 'low')).toBeNull()
    expect(estimateBytes({ bitrate: null, sizeBytes: null, durationMs: 1000, hasAudio: true }, 'low')).toBeNull()
  })
})

describe('checkAudioKept', () => {
  it('AAC、AMR、无音轨、未知都放行', () => {
    expect(checkAudioKept({ hasAudio: true, audioMime: 'audio/mp4a-latm' }).ok).toBe(true)
    expect(checkAudioKept({ hasAudio: true, audioMime: 'audio/3gpp' }).ok).toBe(true)
    expect(checkAudioKept({ hasAudio: false, audioMime: null }).ok).toBe(true)
    expect(checkAudioKept({ hasAudio: true, audioMime: null }).ok).toBe(true)
  })
  it('其他编码不能压缩并说明', () => {
    const r = checkAudioKept({ hasAudio: true, audioMime: 'audio/opus' })
    expect(r.ok).toBe(false)
    expect(r.text).toContain('opus')
  })
})

describe('前后对比', () => {
  it('changeText', () => {
    expect(changeText(1000, 380)).toBe('-62%')
    expect(changeText(1000, 1050)).toBe('+5%')
    expect(changeText(1000, 1000)).toBe('0%')
    expect(changeText(0, 10)).toBe('--')
  })
  it('isNotSmaller：以体积为准，体积未知看 ratio', () => {
    expect(isNotSmaller({ ratio: 0.5, bytes: 50, srcBytes: 100 })).toBe(false)
    expect(isNotSmaller({ ratio: 1, bytes: 100, srcBytes: 100 })).toBe(true)
    expect(isNotSmaller({ ratio: 1.2, bytes: 120, srcBytes: 100 })).toBe(true)
    expect(isNotSmaller({ ratio: 1, bytes: 10, srcBytes: 0 })).toBe(true)
    expect(isNotSmaller({ ratio: 0.5, bytes: 10, srcBytes: 0 })).toBe(false)
  })
  it('preWarning', () => {
    expect(preWarning(900, 1000)).toBe('')
    expect(preWarning(1000, 1000)).toContain('压不小')
    expect(preWarning(null, 1000)).toBe('')
    expect(preWarning(1000, 0)).toBe('')
  })
})

describe('错误辅助', () => {
  it('msgOf 与 isCancelled', () => {
    expect(msgOf(new Error('坏了'), '兜底')).toBe('坏了')
    expect(msgOf(null, '兜底')).toBe('兜底')
    expect(isCancelled({ code: 'CANCELLED' })).toBe(true)
    expect(isCancelled(new Error('x'))).toBe(false)
  })
})
