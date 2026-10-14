import { describe, expect, it } from 'vitest'
import { parseExif } from './exif'

/** 测试用条目：值为字符串（ASCII）或数字数组 */
interface Ent {
  /** 标签号 */
  tag: number
  /** TIFF 类型 */
  type: number
  /** 值 */
  v: number[] | string
}

/** 类型常量 */
const ASCII = 2
const SHORT = 3
const LONG = 4
const RATIONAL = 5

/** 各类型字节宽度 */
const WIDTH: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 }

/** 手工拼一个 TIFF（IFD0 + 可选 ExifIFD + 可选 GPS IFD），再包成 JPEG APP1 */
function buildJpeg(le: boolean, ifd0: Ent[], exif: Ent[] = [], gps: Ent[] = []): Uint8Array {
  const buf = new Uint8Array(4096)
  const dv = new DataView(buf.buffer)
  const ifdLen = (n: number) => 2 + n * 12 + 4
  const e0 = ifd0.slice()
  const off0 = 8
  const offExif = off0 + ifdLen(ifd0.length + (exif.length ? 1 : 0) + (gps.length ? 1 : 0))
  const offGps = offExif + (exif.length ? ifdLen(exif.length) : 0)
  if (exif.length) e0.push({ tag: 0x8769, type: LONG, v: [offExif] })
  if (gps.length) e0.push({ tag: 0x8825, type: LONG, v: [offGps] })
  let data = offGps + (gps.length ? ifdLen(gps.length) : 0)
  dv.setUint16(0, le ? 0x4949 : 0x4d4d)
  dv.setUint16(2, 0x2a, le)
  dv.setUint32(4, off0, le)
  const put = (at: number, ents: Ent[]) => {
    dv.setUint16(at, ents.length, le)
    ents.forEach((e, i) => {
      const p = at + 2 + i * 12
      const bytes: number[] = []
      let count: number
      if (typeof e.v === 'string') {
        for (const ch of e.v) bytes.push(ch.charCodeAt(0))
        bytes.push(0)
        count = bytes.length
      } else {
        const w = WIDTH[e.type]
        count = e.type === RATIONAL ? e.v.length / 2 : e.v.length
        for (const n of e.v) {
          const unit = e.type === RATIONAL ? 4 : w
          const tmp = new DataView(new ArrayBuffer(4))
          if (unit === 2) tmp.setUint16(0, n, le)
          else if (unit === 4) tmp.setUint32(0, n, le)
          else tmp.setUint8(0, n)
          for (let k = 0; k < unit; k++) bytes.push(tmp.getUint8(k))
        }
      }
      dv.setUint16(p, e.tag, le)
      dv.setUint16(p + 2, e.type, le)
      dv.setUint32(p + 4, count, le)
      if (bytes.length <= 4) bytes.forEach((b, k) => dv.setUint8(p + 8 + k, b))
      else {
        dv.setUint32(p + 8, data, le)
        bytes.forEach((b, k) => dv.setUint8(data + k, b))
        data += bytes.length
      }
    })
  }
  put(off0, e0)
  if (exif.length) put(offExif, exif)
  if (gps.length) put(offGps, gps)
  const tiff = buf.subarray(0, data)
  const len = 2 + 6 + tiff.length
  const out = new Uint8Array(2 + 2 + len + 2)
  out.set([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 0xff, 0x45, 0x78, 0x69, 0x66, 0, 0], 0)
  out.set(tiff, 12)
  out.set([0xff, 0xd9], 12 + tiff.length)
  return out
}

/** 一组有代表性的条目 */
function sample(le: boolean): Uint8Array {
  return buildJpeg(
    le,
    [
      { tag: 0x010f, type: ASCII, v: 'Canon' },
      { tag: 0x0110, type: ASCII, v: 'Canon EOS R5' },
      { tag: 0x0112, type: SHORT, v: [6] },
    ],
    [
      { tag: 0x829a, type: RATIONAL, v: [1, 250] },
      { tag: 0x829d, type: RATIONAL, v: [18, 10] },
      { tag: 0x8827, type: SHORT, v: [400] },
      { tag: 0x9003, type: ASCII, v: '2024:05:01 12:30:00' },
      { tag: 0x920a, type: RATIONAL, v: [850, 10] },
      { tag: 0xa002, type: LONG, v: [4000] },
      { tag: 0xa003, type: LONG, v: [3000] },
      { tag: 0xa434, type: ASCII, v: 'RF24-70mm F2.8' },
    ],
    [
      { tag: 1, type: ASCII, v: 'N' },
      { tag: 2, type: RATIONAL, v: [31, 1, 13, 1, 4800, 100] },
      { tag: 3, type: ASCII, v: 'E' },
      { tag: 4, type: RATIONAL, v: [121, 1, 28, 1, 1200, 100] },
      { tag: 5, type: 1, v: [0] },
      { tag: 6, type: RATIONAL, v: [125, 10] },
    ],
  )
}

describe('parseExif', () => {
  for (const le of [true, false]) {
    it(`解析全部字段（${le ? '小端' : '大端'}）`, () => {
      const info = parseExif(sample(le))!
      expect(info.make).toBe('Canon')
      expect(info.model).toBe('Canon EOS R5')
      expect(info.orientation).toBe(6)
      expect(info.exposureTime).toBeCloseTo(1 / 250)
      expect(info.fNumber).toBeCloseTo(1.8)
      expect(info.iso).toBe(400)
      expect(info.dateTimeOriginal).toBe('2024:05:01 12:30:00')
      expect(info.focalLength).toBeCloseTo(85)
      expect(info.pixelWidth).toBe(4000)
      expect(info.pixelHeight).toBe(3000)
      expect(info.lensModel).toBe('RF24-70mm F2.8')
      expect(info.gps!.lat).toBeCloseTo(31 + 13 / 60 + 48 / 3600, 6)
      expect(info.gps!.lon).toBeCloseTo(121 + 28 / 60 + 12 / 3600, 6)
      expect(info.gps!.alt).toBeCloseTo(12.5)
    })
  }

  it('南纬西经海拔为负', () => {
    const bytes = buildJpeg(true, [{ tag: 0x010f, type: ASCII, v: 'X' }], [], [
      { tag: 1, type: ASCII, v: 'S' },
      { tag: 2, type: RATIONAL, v: [33, 1, 30, 1, 0, 1] },
      { tag: 3, type: ASCII, v: 'W' },
      { tag: 4, type: RATIONAL, v: [70, 1, 0, 1, 0, 1] },
      { tag: 5, type: 1, v: [1] },
      { tag: 6, type: RATIONAL, v: [5, 1] },
    ])
    const gps = parseExif(bytes)!.gps!
    expect(gps.lat).toBeCloseTo(-33.5)
    expect(gps.lon).toBeCloseTo(-70)
    expect(gps.alt).toBe(-5)
  })

  it('没有 GPS 时 gps 为空', () => {
    const bytes = buildJpeg(true, [{ tag: 0x0110, type: ASCII, v: 'Cam' }])
    const info = parseExif(bytes)!
    expect(info.model).toBe('Cam')
    expect(info.gps).toBeUndefined()
  })

  it('分母为 0 的有理数忽略', () => {
    const bytes = buildJpeg(true, [{ tag: 0x010f, type: ASCII, v: 'A' }], [{ tag: 0x829d, type: RATIONAL, v: [5, 0] }])
    expect(parseExif(bytes)!.fNumber).toBeUndefined()
  })

  it('非 JPEG 返回 null', () => {
    expect(parseExif(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toBeNull()
    expect(parseExif(new Uint8Array(0))).toBeNull()
  })

  it('没有 APP1 的 JPEG 返回 null', () => {
    // SOI + APP0(长度 4) + SOS
    expect(parseExif(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xda, 0, 2]))).toBeNull()
  })

  it('截断的数据不抛错', () => {
    const full = sample(true)
    for (const n of [14, 20, 40, 100, full.length >> 1]) {
      expect(() => parseExif(full.subarray(0, n))).not.toThrow()
    }
  })

  it('坏字节序标记返回 null', () => {
    const bytes = sample(true).slice()
    bytes[12] = 0x00
    bytes[13] = 0x00
    expect(parseExif(bytes)).toBeNull()
  })

  it('支持带 byteOffset 的 Uint8Array 视图', () => {
    const jpeg = sample(false)
    const padded = new Uint8Array(jpeg.length + 10)
    padded.set(jpeg, 10)
    expect(parseExif(padded.subarray(10))!.model).toBe('Canon EOS R5')
  })
})
