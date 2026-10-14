import { describe, expect, it } from 'vitest'
import { addHistogram, buildPalette, encodeGif, GifWriter, lzwEncode, makePalette, medianCut, quantizeToIndices, toRgbKeys } from './gif-encoder'
import { decodeGif, lzwDecode, parseGif } from './gif-decoder'

/** 规范讲解文档里的 10x10 四色样例：像素下标 */
const SAMPLE_PIXELS = [
  1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 1, 1, 1, 0, 0, 0, 0, 2, 2, 2, 1, 1, 1, 0, 0, 0, 0, 2, 2, 2,
  2, 2, 2, 0, 0, 0, 0, 1, 1, 1, 2, 2, 2, 0, 0, 0, 0, 1, 1, 1, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1,
]
/** 样例对应的 LZW 码流（最小码长 2） */
const SAMPLE_LZW = [0x8c, 0x2d, 0x99, 0x87, 0x2a, 0x1c, 0xdc, 0x33, 0xa0, 0x02, 0x75, 0xec, 0x95, 0xfa, 0xa8, 0xde, 0x60, 0x8c, 0x04, 0x91, 0x4c, 0x01]

/** 生成可复现的伪随机序列 */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** 由颜色数组生成 RGBA 帧（每像素一个 [r,g,b,a]） */
function rgbaOf(px: number[][]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(px.length * 4)
  px.forEach((p, i) => out.set(p, i * 4))
  return out
}

describe('lzwEncode / lzwDecode 规范样例', () => {
  it('解码规范里的码流得到样例像素', () => {
    expect(Array.from(lzwDecode(new Uint8Array(SAMPLE_LZW), 2, 100))).toEqual(SAMPLE_PIXELS)
  })
  it('编码样例像素得到规范里的码流', () => {
    expect(Array.from(lzwEncode(new Uint8Array(SAMPLE_PIXELS), 2))).toEqual(SAMPLE_LZW)
  })
})

describe('lzwEncode 边界', () => {
  it('空输入只有 clear 与结束码', () => {
    expect(lzwDecode(lzwEncode(new Uint8Array(0), 2), 2, 0).length).toBe(0)
  })
  it('单像素往返', () => {
    expect(Array.from(lzwDecode(lzwEncode(new Uint8Array([3]), 2), 2, 1))).toEqual([3])
  })
  it('码长从 9 位涨到 12 位仍可还原（不触发重置）', () => {
    const rnd = lcg(1)
    // 256 色随机数据，约 3500 个像素就会把码表填到接近 4096
    const px = Uint8Array.from({ length: 3000 }, () => Math.floor(rnd() * 256))
    expect(Array.from(lzwDecode(lzwEncode(px, 8), 8, px.length))).toEqual(Array.from(px))
  })
  it('码表写满后发 clear 重置，多轮重置仍可还原', () => {
    const rnd = lcg(7)
    const px = Uint8Array.from({ length: 60000 }, () => Math.floor(rnd() * 256))
    expect(Array.from(lzwDecode(lzwEncode(px, 8), 8, px.length))).toEqual(Array.from(px))
  })
  it('最小码长 2 的长重复数据也能还原', () => {
    const px = new Uint8Array(50000)
    for (let i = 0; i < px.length; i++) px[i] = (i >> 3) & 3
    expect(Array.from(lzwDecode(lzwEncode(px, 2), 2, px.length))).toEqual(Array.from(px))
  })
  it('全同色大块压缩后明显变小', () => {
    expect(lzwEncode(new Uint8Array(10000), 2).length).toBeLessThan(300)
  })
})

describe('toRgbKeys', () => {
  it('不透明像素直接打包', () => {
    expect(toRgbKeys([255, 0, 0, 255], false)[0]).toBe(0xff0000)
  })
  it('开透明时 alpha<128 记为 -1，其余保留原色', () => {
    const k = toRgbKeys([1, 2, 3, 0, 10, 20, 30, 200], true)
    expect(k[0]).toBe(-1)
    expect(k[1]).toBe((10 << 16) | (20 << 8) | 30)
  })
  it('关透明时按底色混合', () => {
    expect(toRgbKeys([0, 0, 0, 0], false)[0]).toBe(0xffffff)
    expect(toRgbKeys([0, 0, 0, 0], false, [10, 20, 30])[0]).toBe((10 << 16) | (20 << 8) | 30)
  })
})

describe('addHistogram / medianCut / makePalette', () => {
  it('直方图统计像素数并忽略透明', () => {
    const h = addHistogram(new Map(), Int32Array.from([5, 5, -1, -1, 5, 9]))
    expect(h.get(5)).toBe(3)
    expect(h.get(9)).toBe(1)
    expect(h.has(-1)).toBe(false)
  })
  it('颜色数不超限时原样保留', () => {
    const h = new Map([[0xff0000, 3], [0x00ff00, 2]])
    expect(medianCut(h, 8).sort((a, b) => a - b)).toEqual([0x00ff00, 0xff0000])
  })
  it('超限时归并到不多于上限', () => {
    const h = new Map<number, number>()
    for (let i = 0; i < 1000; i++) h.set((i * 2654435) & 0xffffff, 1)
    const pal = medianCut(h, 16)
    expect(pal.length).toBeLessThanOrEqual(16)
    expect(pal.length).toBeGreaterThan(8)
  })
  it('调色板补齐到 2 的幂并给透明留槽', () => {
    const p = makePalette([1, 2, 3], false)
    expect(p.bits).toBe(2)
    expect(p.rgb.length).toBe(12)
    expect(p.transparentIndex).toBe(-1)
    const t = makePalette([1, 2, 3, 4], true)
    expect(t.bits).toBe(3)
    expect(t.transparentIndex).toBe(4)
  })
  it('buildPalette 带透明时给透明槽留位', () => {
    const h = new Map<number, number>()
    for (let i = 0; i < 600; i++) h.set(i * 1000, 1)
    const p = buildPalette(h, true)
    expect(p.colorCount + 1).toBeLessThanOrEqual(256)
    expect(p.transparentIndex).toBe(p.colorCount)
  })
})

describe('quantizeToIndices', () => {
  it('调色板内的颜色精确命中，透明像素落到透明槽', () => {
    const pal = makePalette([0xff0000, 0x0000ff], true)
    const idx = quantizeToIndices(Int32Array.from([0x0000ff, -1, 0xff0000]), 3, pal, false)
    expect(Array.from(idx)).toEqual([1, 2, 0])
  })
  it('抖动输出下标都在调色板范围内', () => {
    const pal = makePalette([0x000000, 0xffffff], false)
    const keys = new Int32Array(64).fill(0x808080)
    const idx = quantizeToIndices(keys, 8, pal, true)
    expect(Array.from(idx).every((v) => v === 0 || v === 1)).toBe(true)
    // 中灰抖动后黑白都应出现
    expect(new Set(idx).size).toBe(2)
  })
})

describe('encodeGif 往返', () => {
  it('颜色不超过 256 时往返完全一致', () => {
    const w = 8
    const h = 6
    const px: number[][] = []
    for (let i = 0; i < w * h; i++) px.push([(i * 37) % 256, (i * 91) % 256, (i * 13) % 256, 255])
    const gif = encodeGif([{ data: rgbaOf(px), delayCs: 7 }], { width: w, height: h })
    const dec = decodeGif(gif)
    expect(dec.width).toBe(w)
    expect(dec.height).toBe(h)
    expect(Array.from(dec.frames[0].rgba)).toEqual(Array.from(rgbaOf(px)))
    expect(dec.frames[0].delayCs).toBe(7)
  })
  it('文件头与结尾符合 GIF89a', () => {
    const gif = encodeGif([{ data: rgbaOf([[1, 2, 3, 255]]), delayCs: 1 }], { width: 1, height: 1 })
    expect(String.fromCharCode(...Array.from(gif.subarray(0, 6)))).toBe('GIF89a')
    expect(gif[gif.length - 1]).toBe(0x3b)
  })
  it('多帧：逐帧延迟与像素各自保留', () => {
    const f1 = rgbaOf([[255, 0, 0, 255], [0, 255, 0, 255]])
    const f2 = rgbaOf([[0, 0, 255, 255], [255, 255, 0, 255]])
    const dec = decodeGif(encodeGif([{ data: f1, delayCs: 5 }, { data: f2, delayCs: 20 }], { width: 2, height: 1 }))
    expect(dec.frames.map((f) => f.delayCs)).toEqual([5, 20])
    expect(Array.from(dec.frames[0].rgba)).toEqual(Array.from(f1))
    expect(Array.from(dec.frames[1].rgba)).toEqual(Array.from(f2))
  })
  it('超过 256 色：量化后误差在容许范围内', () => {
    const w = 64
    const h = 64
    const px: number[][] = []
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.push([x * 4, y * 4, (x + y) * 2, 255])
    const src = rgbaOf(px)
    const dec = decodeGif(encodeGif([{ data: src, delayCs: 10 }], { width: w, height: h }))
    let total = 0
    for (let i = 0; i < src.length; i += 4) {
      for (let c = 0; c < 3; c++) total += Math.abs(src[i + c] - dec.frames[0].rgba[i + c])
    }
    expect(total / (w * h * 3)).toBeLessThan(10)
  })
  it('抖动开关都能得到有效 GIF，尺寸一致', () => {
    const w = 16
    const h = 16
    const px: number[][] = []
    for (let i = 0; i < w * h; i++) px.push([i, i, i, 255])
    const src = rgbaOf(px)
    const a = decodeGif(encodeGif([{ data: src, delayCs: 3 }], { width: w, height: h, dither: true, maxColors: 4 }))
    expect(a.frames[0].rgba.length).toBe(w * h * 4)
    const colors = new Set<number>()
    for (let i = 0; i < a.frames[0].rgba.length; i += 4) colors.add(a.frames[0].rgba[i])
    expect(colors.size).toBeLessThanOrEqual(4)
  })
  it('透明：开启时透明像素保持 alpha=0，不透明的原样', () => {
    const src = rgbaOf([[255, 0, 0, 255], [9, 9, 9, 0], [0, 0, 255, 255], [9, 9, 9, 10]])
    const dec = decodeGif(encodeGif([{ data: src, delayCs: 4 }], { width: 2, height: 2, transparent: true }))
    const out = dec.frames[0].rgba
    expect(Array.from(out.subarray(0, 4))).toEqual([255, 0, 0, 255])
    expect(out[7]).toBe(0)
    expect(Array.from(out.subarray(8, 12))).toEqual([0, 0, 255, 255])
    expect(out[15]).toBe(0)
  })
  it('透明：关闭时半透明混合到底色，全部不透明', () => {
    const src = rgbaOf([[0, 0, 0, 0], [255, 0, 0, 255]])
    const dec = decodeGif(encodeGif([{ data: src, delayCs: 4 }], { width: 2, height: 1 }))
    expect(Array.from(dec.frames[0].rgba)).toEqual([255, 255, 255, 255, 255, 0, 0, 255])
  })
  it('全局调色板：多帧共用一张，往返一致', () => {
    const f1 = rgbaOf([[255, 0, 0, 255], [0, 255, 0, 255]])
    const f2 = rgbaOf([[0, 0, 255, 255], [255, 0, 0, 255]])
    const gif = encodeGif([{ data: f1, delayCs: 5 }, { data: f2, delayCs: 5 }], { width: 2, height: 1, globalPalette: true })
    expect(gif[10] & 0x80).toBe(0x80)
    const dec = decodeGif(gif)
    expect(Array.from(dec.frames[1].rgba)).toEqual(Array.from(f2))
  })
  it('全局调色板 + 透明：每帧透明都保留', () => {
    const f1 = rgbaOf([[255, 0, 0, 255], [0, 0, 0, 0]])
    const f2 = rgbaOf([[0, 0, 0, 0], [0, 255, 0, 255]])
    const dec = decodeGif(encodeGif([{ data: f1, delayCs: 5 }, { data: f2, delayCs: 5 }], { width: 2, height: 1, globalPalette: true, transparent: true }))
    expect(dec.frames[0].rgba[7]).toBe(0)
    expect(dec.frames[1].rgba[3]).toBe(0)
    expect(Array.from(dec.frames[1].rgba.subarray(4, 8))).toEqual([0, 255, 0, 255])
  })
  it('单色图（1 种颜色）也能编码', () => {
    const src = rgbaOf(new Array(9).fill([5, 6, 7, 255]))
    const dec = decodeGif(encodeGif([{ data: src, delayCs: 1 }], { width: 3, height: 3 }))
    expect(Array.from(dec.frames[0].rgba)).toEqual(Array.from(src))
  })
  it('大图多重置：256 色噪点 200x200 往返一致', () => {
    const rnd = lcg(3)
    const w = 200
    const h = 200
    const px: number[][] = []
    const palette = Array.from({ length: 256 }, (_, i) => [i, (i * 7) % 256, (i * 13) % 256, 255])
    for (let i = 0; i < w * h; i++) px.push(palette[Math.floor(rnd() * 256)])
    const src = rgbaOf(px)
    const dec = decodeGif(encodeGif([{ data: src, delayCs: 2 }], { width: w, height: h }))
    expect(Array.from(dec.frames[0].rgba)).toEqual(Array.from(src))
  })
})

describe('循环次数（NETSCAPE2.0）', () => {
  const frame = { data: rgbaOf([[1, 2, 3, 255]]), delayCs: 1 }
  const loopOf = (loop?: number): number => parseGif(encodeGif([frame], { width: 1, height: 1, loop })).loop
  it('默认和 0 为无限循环', () => {
    expect(loopOf()).toBe(0)
    expect(loopOf(0)).toBe(0)
  })
  it('1 只播一次，不写循环块', () => {
    expect(loopOf(1)).toBe(1)
    const gif = encodeGif([frame], { width: 1, height: 1, loop: 1 })
    expect(String.fromCharCode(...Array.from(gif)).includes('NETSCAPE2.0')).toBe(false)
  })
  it('n 播 n 次', () => {
    expect(loopOf(3)).toBe(3)
  })
})

describe('GifWriter', () => {
  it('逐帧写入与一次性编码结果一致', () => {
    const f1 = rgbaOf([[1, 2, 3, 255], [4, 5, 6, 255]])
    const f2 = rgbaOf([[7, 8, 9, 255], [1, 2, 3, 255]])
    const w = new GifWriter({ width: 2, height: 1 })
    w.addFrame(f1, 3)
    w.addFrame(f2, 4)
    expect(w.frameCount).toBe(2)
    const a = w.finish()
    const b = encodeGif([{ data: f1, delayCs: 3 }, { data: f2, delayCs: 4 }], { width: 2, height: 1 })
    expect(Array.from(a)).toEqual(Array.from(b))
  })
  it('延迟取整并限制范围', () => {
    const w = new GifWriter({ width: 1, height: 1 })
    w.addFrame(rgbaOf([[0, 0, 0, 255]]), 7.6)
    w.addFrame(rgbaOf([[0, 0, 0, 255]]), 999999)
    const dec = decodeGif(w.finish())
    expect(dec.frames.map((f) => f.delayCs)).toEqual([8, 65535])
  })
  it('没有帧、尺寸非法、像素长度不符、结束后再加帧都抛错', () => {
    expect(() => new GifWriter({ width: 1, height: 1 }).finish()).toThrow()
    expect(() => new GifWriter({ width: 0, height: 1 })).toThrow()
    expect(() => new GifWriter({ width: 70000, height: 1 })).toThrow()
    const w = new GifWriter({ width: 2, height: 2 })
    expect(() => w.addFrame(new Uint8Array(4), 1)).toThrow()
    const ok = new GifWriter({ width: 1, height: 1 })
    ok.addFrame(rgbaOf([[0, 0, 0, 255]]), 1)
    ok.finish()
    expect(() => ok.addFrame(rgbaOf([[0, 0, 0, 255]]), 1)).toThrow()
    expect(() => encodeGif([], { width: 1, height: 1 })).toThrow()
  })
})

describe('gif-decoder 解析', () => {
  it('parseGif 拿到帧数与延迟但不解压', () => {
    const f = rgbaOf([[1, 1, 1, 255]])
    const info = parseGif(encodeGif([{ data: f, delayCs: 3 }, { data: f, delayCs: 9 }], { width: 1, height: 1 }))
    expect(info.frames.map((x) => x.delayCs)).toEqual([3, 9])
  })
  it('不是 GIF 时抛错', () => {
    expect(() => parseGif(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]))).toThrow('不是有效的 GIF')
  })
  it('能读隔行 GIF：规范样例手工包装成隔行', () => {
    // 4 行 1 列：隔行顺序为第 0、第 2、第 1、第 3 行（4 行时：pass0 行0，pass1 无，pass2 行2，pass3 行1、3）
    const rows = [10, 11, 12, 13]
    const order = [rows[0], rows[2], rows[1], rows[3]]
    const lzw = lzwEncode(Uint8Array.from(order.map((v) => v - 10)), 2)
    const bytes: number[] = [...Array.from('GIF89a').map((c) => c.charCodeAt(0)), 1, 0, 4, 0, 0x81, 0, 0]
    bytes.push(10, 10, 10, 20, 20, 20, 30, 30, 30, 40, 40, 40)
    bytes.push(0x2c, 0, 0, 0, 0, 1, 0, 4, 0, 0x40, 2, lzw.length, ...Array.from(lzw), 0, 0x3b)
    const dec = decodeGif(Uint8Array.from(bytes))
    const reds = [0, 1, 2, 3].map((y) => dec.frames[0].rgba[y * 4])
    expect(reds).toEqual([10, 20, 30, 40])
  })
})
