import { describe, expect, it } from 'vitest'
import { buildRows, cameraName, detectKind, formatAperture, formatExifDate, formatExposure, formatFocal, formatGps, kindLabel } from './logic'

describe('detectKind', () => {
  it('识别常见格式', () => {
    expect(detectKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg')
    expect(detectKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe('png')
    expect(detectKind(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBe('gif')
    expect(detectKind(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe('webp')
  })
  it('认不出或太短为 unknown', () => {
    expect(detectKind(new Uint8Array([1, 2, 3]))).toBe('unknown')
    expect(detectKind(new Uint8Array(0))).toBe('unknown')
  })
})

describe('kindLabel', () => {
  it('显示名', () => {
    expect(kindLabel('webp')).toBe('WebP')
    expect(kindLabel('unknown')).toBe('未知')
  })
})

describe('formatAperture', () => {
  it('小数与整数', () => {
    expect(formatAperture(1.8)).toBe('f/1.8')
    expect(formatAperture(8)).toBe('f/8')
    expect(formatAperture(2.8000001)).toBe('f/2.8')
  })
})

describe('formatExposure', () => {
  it('快门分数与秒', () => {
    expect(formatExposure(1 / 250)).toBe('1/250 s')
    expect(formatExposure(2)).toBe('2 s')
    expect(formatExposure(0.5)).toBe('0.5 s')
    expect(formatExposure(0)).toBe('—')
  })
})

describe('formatFocal', () => {
  it('焦距', () => {
    expect(formatFocal(26)).toBe('26 mm')
    expect(formatFocal(4.25)).toBe('4.3 mm')
  })
})

describe('formatExifDate', () => {
  it('转可读格式', () => {
    expect(formatExifDate('2024:05:01 12:30:00')).toBe('2024-05-01 12:30:00')
    expect(formatExifDate('乱写')).toBe('乱写')
  })
})

describe('formatGps', () => {
  it('带方位', () => {
    expect(formatGps({ lat: 31.5, lon: 121.25 })).toBe('31.500000°N, 121.250000°E')
    expect(formatGps({ lat: -33.5, lon: -70 })).toBe('33.500000°S, 70.000000°W')
  })
})

describe('cameraName', () => {
  it('不重复厂商', () => {
    expect(cameraName('Canon', 'Canon EOS R5')).toBe('Canon EOS R5')
    expect(cameraName('Apple', 'iPhone 15')).toBe('Apple iPhone 15')
    expect(cameraName(undefined, 'X')).toBe('X')
    expect(cameraName('Sony', undefined)).toBe('Sony')
    expect(cameraName()).toBe('')
  })
})

describe('buildRows', () => {
  const base = { name: 'a.jpg', kind: 'jpeg' as const, size: 2048, width: 400, height: 300 }
  it('无 EXIF 只有基础信息', () => {
    const rows = buildRows(base, null)
    expect(rows.map((r) => r.label)).toEqual(['文件名', '格式', '体积', '尺寸'])
    expect(rows[3].value).toBe('400 × 300')
  })
  it('宽高为 0 不显示尺寸', () => {
    expect(buildRows({ ...base, width: 0, height: 0 }, null).some((r) => r.label === '尺寸')).toBe(false)
  })
  it('带 EXIF 追加相机参数，缺失的不出现', () => {
    const rows = buildRows(base, { make: 'Canon', model: 'R5', fNumber: 2, iso: 100, dateTimeOriginal: '2024:01:02 03:04:05' })
    const m = Object.fromEntries(rows.map((r) => [r.label, r.value]))
    expect(m['相机']).toBe('Canon R5')
    expect(m['光圈']).toBe('f/2')
    expect(m['ISO']).toBe('100')
    expect(m['拍摄时间']).toBe('2024-01-02 03:04:05')
    expect(m['快门']).toBeUndefined()
  })
})
