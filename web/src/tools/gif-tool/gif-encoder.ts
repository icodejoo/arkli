/**
 * 自写 GIF89a 编码器：中位切分量化、可选 Floyd-Steinberg 抖动、LZW 压缩、
 * 全局/局部调色板、逐帧延迟、NETSCAPE2.0 循环、可选透明色。
 * 输入是 RGBA 像素帧，输出 Uint8Array；不依赖 DOM，可直接在单测里跑。
 */

/** RGB 三元组（0~255） */
export type Rgb = [number, number, number]

/** 输入帧：RGBA 像素 + 延迟 */
export interface GifFrameInput {
  /** RGBA 像素，长度须为 宽*高*4 */
  data: ArrayLike<number>
  /** 本帧延迟，单位 1/100 秒 */
  delayCs: number
}

/** 编码选项 */
export interface GifEncodeOptions {
  /** 画面宽（1~65535） */
  width: number
  /** 画面高（1~65535） */
  height: number
  /** 播放次数：0 无限循环（默认），1 只播一次（不写循环块），n>1 播 n 次 */
  loop?: number
  /** 是否保留透明：alpha<128 的像素变透明色；关闭时按 background 混合成不透明 */
  transparent?: boolean
  /** 是否启用 Floyd-Steinberg 抖动，默认关 */
  dither?: boolean
  /** 全部帧共用一张调色板（encodeGif 专用，需要同时持有所有帧），默认逐帧局部调色板 */
  globalPalette?: boolean
  /** 不保留透明时的混合底色，默认白色 */
  background?: Rgb
  /** 调色板最大颜色数（2~256），默认 256 */
  maxColors?: number
}

/** 调色板（已补齐到 2 的幂） */
export interface GifPalette {
  /** RGB 字节，长度 = 2^bits * 3 */
  rgb: Uint8Array
  /** 实际有效颜色数（不含补齐项与透明项） */
  colorCount: number
  /** 透明色下标，没有透明为 -1 */
  transparentIndex: number
  /** 调色板位数（颜色数 = 2^bits，1~8） */
  bits: number
}

/** GIF 调色板最大颜色数 */
export const GIF_MAX_COLORS = 256
/** LZW 最小码长下限（规范要求至少 2） */
export const LZW_MIN_CODE_SIZE = 2
/** LZW 最大码长 */
const LZW_MAX_BITS = 12
/** LZW 码表容量 */
const LZW_TABLE_SIZE = 1 << LZW_MAX_BITS
/** 数据子块最大字节数 */
const SUB_BLOCK_MAX = 255
/** alpha 低于此值视为透明 */
const ALPHA_CUTOFF = 128
/** 透明像素在 RGB 键数组里的标记 */
const TRANSPARENT_KEY = -1
/** 默认混合底色 */
const DEFAULT_BG: Rgb = [255, 255, 255]
/** 画面尺寸上限（GIF 用 16 位存） */
const MAX_DIMENSION = 65535
/** 延迟上限（16 位） */
const MAX_DELAY_CS = 65535
/** 5-5-5 近似色缓存的位移 */
const CACHE_SHIFT = 3
/** 5-5-5 近似色缓存大小 */
const CACHE_SIZE = 1 << 15
/** 抖动误差扩散的分母 */
const FS_DIV = 16
/** 全部块的结束标志 */
const TRAILER = 0x3b
/** 扩展块引导符 */
const EXT_INTRODUCER = 0x21
/** 图像描述符引导符 */
const IMAGE_SEPARATOR = 0x2c
/** 图形控制扩展标签 */
const LABEL_GCE = 0xf9
/** 应用扩展标签 */
const LABEL_APP = 0xff
/** 应用扩展名（循环） */
const NETSCAPE = 'NETSCAPE2.0'

/** 可增长的字节缓冲 */
class ByteSink {
  /** 底层存储 */
  private buf = new Uint8Array(4096)
  /** 已写入长度 */
  private len = 0

  /** 保证还能再放 n 字节 */
  private grow(n: number): void {
    if (this.len + n <= this.buf.length) return
    let cap = this.buf.length
    while (cap < this.len + n) cap *= 2
    const next = new Uint8Array(cap)
    next.set(this.buf.subarray(0, this.len))
    this.buf = next
  }

  /** 写一个字节 */
  push(b: number): void {
    this.grow(1)
    this.buf[this.len++] = b
  }

  /** 写一段字节 */
  pushBytes(bytes: Uint8Array): void {
    this.grow(bytes.length)
    this.buf.set(bytes, this.len)
    this.len += bytes.length
  }

  /** 写 16 位小端整数 */
  push16(v: number): void {
    this.push(v & 0xff)
    this.push((v >> 8) & 0xff)
  }

  /** 写 ASCII 字符串 */
  pushText(s: string): void {
    for (let i = 0; i < s.length; i++) this.push(s.charCodeAt(i))
  }

  /** 取出结果（拷贝一份刚好大小的数组） */
  toBytes(): Uint8Array {
    return this.buf.slice(0, this.len)
  }
}

/**
 * 把 RGBA 像素压成 24 位 RGB 键；透明像素为 -1。
 *
 * @param rgba RGBA 像素
 * @param transparent 为 true 时 alpha<128 记为透明；否则一律与底色混合
 * @param bg 混合底色，默认白
 * @returns 每像素一个整数键（r<<16|g<<8|b）
 * @example toRgbKeys([255, 0, 0, 255], false)[0] // 0xff0000
 */
export function toRgbKeys(rgba: ArrayLike<number>, transparent: boolean, bg: Rgb = DEFAULT_BG): Int32Array {
  const n = rgba.length >> 2
  const out = new Int32Array(n)
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const a = rgba[p + 3]
    if (a === 255) {
      out[i] = (rgba[p] << 16) | (rgba[p + 1] << 8) | rgba[p + 2]
    } else if (transparent) {
      out[i] = a < ALPHA_CUTOFF ? TRANSPARENT_KEY : (rgba[p] << 16) | (rgba[p + 1] << 8) | rgba[p + 2]
    } else {
      const r = Math.round((rgba[p] * a + bg[0] * (255 - a)) / 255)
      const g = Math.round((rgba[p + 1] * a + bg[1] * (255 - a)) / 255)
      const b = Math.round((rgba[p + 2] * a + bg[2] * (255 - a)) / 255)
      out[i] = (r << 16) | (g << 8) | b
    }
  }
  return out
}

/**
 * 把一帧的颜色计数累加进直方图（透明像素忽略）。
 *
 * @param hist 直方图：颜色键 -> 像素数
 * @param keys toRgbKeys 的结果
 * @returns 传入的直方图
 */
export function addHistogram(hist: Map<number, number>, keys: Int32Array): Map<number, number> {
  // 合并连续相同颜色，少查几次 Map
  let last = TRANSPARENT_KEY - 1
  let run = 0
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]
    if (k === last) {
      if (k !== TRANSPARENT_KEY) run++
      continue
    }
    if (run > 0) hist.set(last, (hist.get(last) ?? 0) + run)
    last = k
    run = k === TRANSPARENT_KEY ? 0 : 1
  }
  if (run > 0) hist.set(last, (hist.get(last) ?? 0) + run)
  return hist
}

/** 中位切分用的颜色项 */
interface ColorEntry {
  r: number
  g: number
  b: number
  /** 像素数 */
  n: number
}

/** 中位切分的盒子（区间 [lo,hi)） */
interface Box {
  lo: number
  hi: number
  /** 最宽的通道：0 r、1 g、2 b */
  axis: number
  /** 该通道的取值跨度 */
  range: number
  /** 盒内像素总数 */
  count: number
}

/** 取颜色项的某个通道 */
function channel(e: ColorEntry, axis: number): number {
  return axis === 0 ? e.r : axis === 1 ? e.g : e.b
}

/** 统计盒子的最宽通道与像素数 */
function measureBox(entries: ColorEntry[], lo: number, hi: number): Box {
  let r0 = 255, r1 = 0, g0 = 255, g1 = 0, b0 = 255, b1 = 0, count = 0
  for (let i = lo; i < hi; i++) {
    const e = entries[i]
    if (e.r < r0) r0 = e.r
    if (e.r > r1) r1 = e.r
    if (e.g < g0) g0 = e.g
    if (e.g > g1) g1 = e.g
    if (e.b < b0) b0 = e.b
    if (e.b > b1) b1 = e.b
    count += e.n
  }
  const rr = r1 - r0, gr = g1 - g0, br = b1 - b0
  const range = Math.max(rr, gr, br)
  return { lo, hi, axis: range === rr ? 0 : range === gr ? 1 : 2, range, count }
}

/**
 * 中位切分量化：把直方图里的颜色归并成不超过 maxColors 种。
 * 颜色本来就不多时原样返回（保证往返无损）。
 *
 * @param hist 颜色键 -> 像素数
 * @param maxColors 目标颜色数上限（≥1）
 * @returns 调色板颜色键数组
 * @example medianCut(new Map([[0xff0000, 5], [0x0000ff, 5]]), 4) // [0xff0000, 0x0000ff]
 */
export function medianCut(hist: Map<number, number>, maxColors: number): number[] {
  const entries: ColorEntry[] = []
  hist.forEach((n, key) => entries.push({ r: key >> 16, g: (key >> 8) & 0xff, b: key & 0xff, n }))
  if (entries.length <= maxColors) return entries.map((e) => (e.r << 16) | (e.g << 8) | e.b)

  const boxes: Box[] = [measureBox(entries, 0, entries.length)]
  while (boxes.length < maxColors) {
    // 挑得分最高的可再分盒子：跨度 × 像素数
    let pick = -1
    let best = 0
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i]
      if (b.hi - b.lo < 2 || b.range === 0) continue
      const score = b.range * b.count
      if (score > best) {
        best = score
        pick = i
      }
    }
    if (pick < 0) break
    const box = boxes[pick]
    const part = entries.slice(box.lo, box.hi).sort((x, y) => channel(x, box.axis) - channel(y, box.axis))
    for (let i = 0; i < part.length; i++) entries[box.lo + i] = part[i]
    // 按像素数的加权中位数切
    const half = box.count / 2
    let acc = 0
    let cut = box.lo + 1
    for (let i = box.lo; i < box.hi - 1; i++) {
      acc += entries[i].n
      cut = i + 1
      if (acc >= half) break
    }
    boxes.splice(pick, 1, measureBox(entries, box.lo, cut), measureBox(entries, cut, box.hi))
  }

  return boxes.map((b) => {
    let r = 0, g = 0, bl = 0
    for (let i = b.lo; i < b.hi; i++) {
      const e = entries[i]
      r += e.r * e.n
      g += e.g * e.n
      bl += e.b * e.n
    }
    const c = Math.max(1, b.count)
    return (Math.round(r / c) << 16) | (Math.round(g / c) << 8) | Math.round(bl / c)
  })
}

/**
 * 由颜色键生成补齐到 2 的幂的调色板；有透明时在颜色后追加一个透明槽。
 *
 * @param colors 颜色键数组（长度 ≥ 0）
 * @param withTransparent 是否预留透明色
 * @returns 调色板
 * @example makePalette([0xff0000], true).transparentIndex // 1
 */
export function makePalette(colors: number[], withTransparent: boolean): GifPalette {
  const total = colors.length + (withTransparent ? 1 : 0)
  let bits = 1
  while (1 << bits < total) bits++
  const rgb = new Uint8Array((1 << bits) * 3)
  colors.forEach((k, i) => {
    rgb[i * 3] = k >> 16
    rgb[i * 3 + 1] = (k >> 8) & 0xff
    rgb[i * 3 + 2] = k & 0xff
  })
  return { rgb, colorCount: colors.length, transparentIndex: withTransparent ? colors.length : -1, bits }
}

/**
 * 从直方图建调色板（中位切分），并预留透明槽。
 *
 * @param hist 颜色直方图
 * @param withTransparent 是否需要透明色
 * @param maxColors 总颜色数上限（含透明槽），默认 256
 * @returns 调色板
 */
export function buildPalette(hist: Map<number, number>, withTransparent: boolean, maxColors = GIF_MAX_COLORS): GifPalette {
  const room = Math.max(1, Math.min(GIF_MAX_COLORS, maxColors) - (withTransparent ? 1 : 0))
  return makePalette(medianCut(hist, room), withTransparent)
}

/** 在调色板里找最近的颜色下标（欧氏距离平方） */
function nearest(pal: GifPalette, r: number, g: number, b: number): number {
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < pal.colorCount; i++) {
    const dr = pal.rgb[i * 3] - r
    const dg = pal.rgb[i * 3 + 1] - g
    const db = pal.rgb[i * 3 + 2] - b
    const d = dr * dr + dg * dg + db * db
    if (d < bestD) {
      bestD = d
      best = i
      if (d === 0) break
    }
  }
  return best
}

/** 生成带 5-5-5 缓存的最近色查找函数 */
function makeLookup(pal: GifPalette): (r: number, g: number, b: number) => number {
  const cache = new Int16Array(CACHE_SIZE).fill(-1)
  return (r, g, b) => {
    const ck = ((r >> CACHE_SHIFT) << 10) | ((g >> CACHE_SHIFT) << 5) | (b >> CACHE_SHIFT)
    let idx = cache[ck]
    if (idx < 0) {
      idx = nearest(pal, r, g, b)
      cache[ck] = idx
    }
    return idx
  }
}

/** 限制到 0~255 */
function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v
}

/**
 * 把 RGB 键映射成调色板下标。调色板里有的颜色精确命中，其余取最近色。
 *
 * @param keys toRgbKeys 的结果
 * @param width 画面宽（抖动按行扩散需要）
 * @param pal 调色板
 * @param dither 是否 Floyd-Steinberg 抖动
 * @returns 每像素一个调色板下标；透明像素为 pal.transparentIndex
 */
export function quantizeToIndices(keys: Int32Array, width: number, pal: GifPalette, dither: boolean): Uint8Array {
  const out = new Uint8Array(keys.length)
  const lookup = makeLookup(pal)
  const tIdx = Math.max(0, pal.transparentIndex)
  if (!dither) {
    const exact = new Map<number, number>()
    for (let i = 0; i < pal.colorCount; i++) {
      const k = (pal.rgb[i * 3] << 16) | (pal.rgb[i * 3 + 1] << 8) | pal.rgb[i * 3 + 2]
      if (!exact.has(k)) exact.set(k, i)
    }
    let lastKey = TRANSPARENT_KEY - 1
    let lastIdx = 0
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]
      if (k !== lastKey) {
        lastKey = k
        lastIdx = k < 0 ? tIdx : exact.get(k) ?? lookup(k >> 16, (k >> 8) & 0xff, k & 0xff)
      }
      out[i] = lastIdx
    }
    return out
  }
  // Floyd-Steinberg：两行误差缓冲，每像素 3 通道，左右各留一格边距
  const height = Math.floor(keys.length / width)
  let cur = new Float32Array((width + 2) * 3)
  let nxt = new Float32Array((width + 2) * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const k = keys[i]
      if (k < 0) {
        out[i] = tIdx
        continue
      }
      const o = (x + 1) * 3
      const r = clamp255(Math.round((k >> 16) + cur[o]))
      const g = clamp255(Math.round(((k >> 8) & 0xff) + cur[o + 1]))
      const b = clamp255(Math.round((k & 0xff) + cur[o + 2]))
      const idx = lookup(r, g, b)
      out[i] = idx
      const er = r - pal.rgb[idx * 3]
      const eg = g - pal.rgb[idx * 3 + 1]
      const eb = b - pal.rgb[idx * 3 + 2]
      for (let c = 0; c < 3; c++) {
        const e = c === 0 ? er : c === 1 ? eg : eb
        cur[o + 3 + c] += (e * 7) / FS_DIV
        nxt[o - 3 + c] += (e * 3) / FS_DIV
        nxt[o + c] += (e * 5) / FS_DIV
        nxt[o + 3 + c] += e / FS_DIV
      }
    }
    const t = cur
    cur = nxt
    nxt = t
    nxt.fill(0)
  }
  return out
}

/**
 * GIF 变长 LZW 压缩（含 clear code、结束码；码表满 4096 时发 clear 重置）。
 * 返回未分块的原始码流字节，由调用方切成数据子块。
 *
 * @param indices 调色板下标序列
 * @param minCodeSize 最小码长（2~8），一般取 max(2, 调色板位数)
 * @returns LZW 码流
 * @example lzwEncode(new Uint8Array([0, 1, 0, 1]), 2)
 */
export function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clear = 1 << minCodeSize
  const eoi = clear + 1
  const out = new ByteSink()
  let bitBuf = 0
  let bitCnt = 0
  let size = minCodeSize + 1
  let next = eoi + 1
  const dict = new Map<number, number>()

  /** 写一个码 */
  const emit = (code: number): void => {
    bitBuf |= code << bitCnt
    bitCnt += size
    while (bitCnt >= 8) {
      out.push(bitBuf & 0xff)
      bitBuf >>>= 8
      bitCnt -= 8
    }
  }
  /** 写完码后，若码表项数到达 2^size 则码长加一（与解码端同步） */
  const grow = (): void => {
    if (next === 1 << size && size < LZW_MAX_BITS) size++
  }

  emit(clear)
  if (indices.length > 0) {
    let cur = indices[0]
    for (let i = 1; i < indices.length; i++) {
      const key = (cur << 8) | indices[i]
      const hit = dict.get(key)
      if (hit !== undefined) {
        cur = hit
        continue
      }
      emit(cur)
      grow()
      if (next < LZW_TABLE_SIZE) {
        dict.set(key, next++)
      } else {
        emit(clear)
        dict.clear()
        size = minCodeSize + 1
        next = eoi + 1
      }
      cur = indices[i]
    }
    emit(cur)
    grow()
  }
  emit(eoi)
  if (bitCnt > 0) out.push(bitBuf & 0xff)
  return out.toBytes()
}

/** 写数据子块序列（每块 ≤255 字节，末尾 0 长度块） */
function writeSubBlocks(sink: ByteSink, data: Uint8Array): void {
  for (let off = 0; off < data.length; off += SUB_BLOCK_MAX) {
    const n = Math.min(SUB_BLOCK_MAX, data.length - off)
    sink.push(n)
    sink.pushBytes(data.subarray(off, off + n))
  }
  sink.push(0)
}

/** 把延迟取整并限制到 0~65535 */
function clampDelay(cs: number): number {
  return Math.max(0, Math.min(MAX_DELAY_CS, Math.round(cs) || 0))
}

/**
 * 逐帧写入的 GIF 编码器：每帧调 addFrame 就立即压缩，适合帧多时控内存。
 * 全局调色板模式需在构造时给出调色板；平时用局部调色板即可。
 *
 * @example
 * const w = new GifWriter({ width: 2, height: 1, loop: 0 })
 * w.addFrame(new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]), 10)
 * const bytes = w.finish()
 */
export class GifWriter {
  /** 输出缓冲 */
  private readonly sink = new ByteSink()
  /** 画面宽 */
  private readonly width: number
  /** 画面高 */
  private readonly height: number
  /** 是否保留透明 */
  private readonly transparent: boolean
  /** 是否抖动 */
  private readonly dither: boolean
  /** 混合底色 */
  private readonly background: Rgb
  /** 调色板颜色上限 */
  private readonly maxColors: number
  /** 全局调色板（有则所有帧共用） */
  private readonly shared?: GifPalette
  /** 已写帧数 */
  private count = 0
  /** 是否已结束 */
  private done = false

  /**
   * @param opts 编码选项
   * @param shared 全局调色板，缺省用逐帧局部调色板
   */
  constructor(opts: GifEncodeOptions, shared?: GifPalette) {
    const { width, height } = opts
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
      throw new Error(`GIF 尺寸无效：${width}x${height}`)
    }
    this.width = width
    this.height = height
    this.transparent = !!opts.transparent
    this.dither = !!opts.dither
    this.background = opts.background ?? DEFAULT_BG
    this.maxColors = Math.max(2, Math.min(GIF_MAX_COLORS, opts.maxColors ?? GIF_MAX_COLORS))
    this.shared = shared

    const s = this.sink
    s.pushText('GIF89a')
    s.push16(width)
    s.push16(height)
    // 全局调色板标志 | 颜色分辨率 8 位 | 调色板大小
    s.push(shared ? 0x80 | 0x70 | (shared.bits - 1) : 0x70)
    s.push(0) // 背景色下标
    s.push(0) // 像素宽高比
    if (shared) s.pushBytes(shared.rgb)
    const loop = opts.loop ?? 0
    if (loop !== 1) {
      s.push(EXT_INTRODUCER)
      s.push(LABEL_APP)
      s.push(11)
      s.pushText(NETSCAPE)
      s.push(3)
      s.push(1)
      s.push16(loop === 0 ? 0 : Math.min(MAX_DELAY_CS, loop - 1))
      s.push(0)
    }
  }

  /**
   * 追加一帧。
   *
   * @param data RGBA 像素，长度须为 宽*高*4
   * @param delayCs 延迟，单位 1/100 秒
   */
  addFrame(data: ArrayLike<number>, delayCs: number): void {
    if (this.done) throw new Error('GIF 已结束，不能再加帧')
    if (data.length !== this.width * this.height * 4) throw new Error('帧像素长度与画面尺寸不符')
    const keys = toRgbKeys(data, this.transparent, this.background)
    const hasTrans = this.transparent && keys.indexOf(TRANSPARENT_KEY) >= 0
    let pal = this.shared
    if (!pal) pal = buildPalette(addHistogram(new Map(), keys), hasTrans, this.maxColors)
    const indices = quantizeToIndices(keys, this.width, pal, this.dither)
    // 全局调色板里没有透明槽但本帧有透明像素时，透明处只能落到最近色（建全局板时已统一扫描，正常不会发生）
    const useTrans = hasTrans && pal.transparentIndex >= 0
    const s = this.sink
    s.push(EXT_INTRODUCER)
    s.push(LABEL_GCE)
    s.push(4)
    // 处置方式：有透明时 2（还原到背景），保证每帧独立；否则 1（保留）
    s.push((useTrans ? 2 : 1) << 2 | (useTrans ? 1 : 0))
    s.push16(clampDelay(delayCs))
    s.push(useTrans ? pal.transparentIndex : 0)
    s.push(0)
    s.push(IMAGE_SEPARATOR)
    s.push16(0)
    s.push16(0)
    s.push16(this.width)
    s.push16(this.height)
    if (this.shared) {
      s.push(0)
    } else {
      s.push(0x80 | (pal.bits - 1))
      s.pushBytes(pal.rgb)
    }
    const minCode = Math.max(LZW_MIN_CODE_SIZE, pal.bits)
    s.push(minCode)
    writeSubBlocks(s, lzwEncode(indices, minCode))
    this.count++
  }

  /** 已写入的帧数 */
  get frameCount(): number {
    return this.count
  }

  /**
   * 结束并取出完整 GIF 字节。至少要有一帧。
   *
   * @returns GIF 文件内容
   */
  finish(): Uint8Array {
    if (this.count === 0) throw new Error('GIF 至少需要一帧')
    if (!this.done) {
      this.sink.push(TRAILER)
      this.done = true
    }
    return this.sink.toBytes()
  }
}

/**
 * 一次性把全部帧编码成 GIF。
 *
 * @param frames RGBA 帧数组（至少一帧）
 * @param opts 编码选项；globalPalette 为 true 时所有帧合并统计颜色，共用一张调色板
 * @returns GIF 文件内容
 * @example
 * const gif = encodeGif([{ data: rgba, delayCs: 10 }], { width: 16, height: 16 })
 */
export function encodeGif(frames: GifFrameInput[], opts: GifEncodeOptions): Uint8Array {
  if (frames.length === 0) throw new Error('GIF 至少需要一帧')
  let shared: GifPalette | undefined
  if (opts.globalPalette) {
    const transparent = !!opts.transparent
    const hist = new Map<number, number>()
    let hasTrans = false
    for (const f of frames) {
      const keys = toRgbKeys(f.data, transparent, opts.background ?? DEFAULT_BG)
      addHistogram(hist, keys)
      if (transparent && !hasTrans && keys.indexOf(TRANSPARENT_KEY) >= 0) hasTrans = true
    }
    shared = buildPalette(hist, hasTrans, Math.max(2, opts.maxColors ?? GIF_MAX_COLORS))
  }
  const w = new GifWriter(opts, shared)
  for (const f of frames) w.addFrame(f.data, f.delayCs)
  return w.finish()
}
