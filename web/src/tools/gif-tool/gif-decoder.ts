/**
 * 最小 GIF 解码器：解析块结构、LZW 解压、隔行、透明与处置方式，合成出每帧完整画面。
 * 主要给单测做往返校验，也作为 WebView 没有 ImageDecoder 时的兜底。不依赖 DOM。
 */

/** 解析出的单帧元数据（不含像素） */
export interface ParsedFrame {
  /** 子图左上角 x */
  left: number
  /** 子图左上角 y */
  top: number
  /** 子图宽 */
  w: number
  /** 子图高 */
  h: number
  /** 是否隔行 */
  interlaced: boolean
  /** 调色板 RGB 字节（局部优先，否则全局） */
  palette: Uint8Array
  /** 透明色下标，没有为 -1 */
  transparentIndex: number
  /** 处置方式 0~3 */
  disposal: number
  /** 延迟，单位 1/100 秒（原值，不做最小值修正） */
  delayCs: number
  /** LZW 最小码长 */
  minCodeSize: number
  /** 拼接后的 LZW 码流 */
  data: Uint8Array
}

/** 解析结果 */
export interface ParsedGif {
  /** 画面宽 */
  width: number
  /** 画面高 */
  height: number
  /** 播放次数：0 无限循环，1 只播一次（没有循环块），n 播 n 次 */
  loop: number
  /** 各帧元数据 */
  frames: ParsedFrame[]
}

/** 合成后的完整帧 */
export interface DecodedFrame {
  /** 整个画面的 RGBA 像素 */
  rgba: Uint8ClampedArray
  /** 延迟，单位 1/100 秒 */
  delayCs: number
}

/** LZW 码表上限位数 */
const MAX_BITS = 12
/** LZW 码表容量 */
const TABLE_SIZE = 1 << MAX_BITS
/** 隔行扫描四趟的起始行 */
const INTERLACE_START = [0, 4, 2, 1]
/** 隔行扫描四趟的行步长 */
const INTERLACE_STEP = [8, 8, 4, 2]

/**
 * GIF 变长 LZW 解压。
 *
 * @param data 未分块的 LZW 码流
 * @param minCodeSize 最小码长
 * @param pixelCount 期望输出像素数
 * @returns 调色板下标序列，长度 = pixelCount（数据不足时尾部为 0）
 * @example lzwDecode(bytes, 2, 100)
 */
export function lzwDecode(data: Uint8Array, minCodeSize: number, pixelCount: number): Uint8Array {
  const clear = 1 << minCodeSize
  const eoi = clear + 1
  const prefix = new Uint16Array(TABLE_SIZE)
  const suffix = new Uint8Array(TABLE_SIZE)
  const stack = new Uint8Array(TABLE_SIZE + 1)
  const out = new Uint8Array(pixelCount)
  let op = 0
  let size = minCodeSize + 1
  let next = eoi + 1
  let prev = -1
  let first = 0
  let bits = 0
  let nbits = 0
  let pos = 0
  while (op < pixelCount) {
    while (nbits < size && pos < data.length) {
      bits |= data[pos++] << nbits
      nbits += 8
    }
    if (nbits < size) break
    const code = bits & ((1 << size) - 1)
    bits >>>= size
    nbits -= size
    if (code === clear) {
      size = minCodeSize + 1
      next = eoi + 1
      prev = -1
      continue
    }
    if (code === eoi) break
    if (prev === -1) {
      if (code >= clear) throw new Error('GIF 数据损坏')
      out[op++] = code
      prev = code
      first = code
      continue
    }
    let sp = 0
    let c = code
    if (code >= next) {
      if (code > next) throw new Error('GIF 数据损坏')
      stack[sp++] = first
      c = prev
    }
    while (c >= clear) {
      stack[sp++] = suffix[c]
      c = prefix[c]
    }
    first = c
    stack[sp++] = c
    while (sp > 0 && op < pixelCount) out[op++] = stack[--sp]
    if (next < TABLE_SIZE) {
      prefix[next] = prev
      suffix[next] = first
      next++
      if (next === 1 << size && size < MAX_BITS) size++
    }
    prev = code
  }
  return out
}

/** 读 16 位小端整数 */
function u16(b: Uint8Array, p: number): number {
  return b[p] | (b[p + 1] << 8)
}

/** 读数据子块序列，返回拼接内容和结束位置 */
function readSubBlocks(b: Uint8Array, start: number): { data: Uint8Array; end: number } {
  const parts: Uint8Array[] = []
  let p = start
  let total = 0
  while (p < b.length) {
    const n = b[p++]
    if (n === 0) break
    parts.push(b.subarray(p, p + n))
    total += n
    p += n
  }
  const data = new Uint8Array(total)
  let o = 0
  for (const part of parts) {
    data.set(part, o)
    o += part.length
  }
  return { data, end: p }
}

/**
 * 解析 GIF 的块结构，不做 LZW 解压（很快，适合先拿帧数/尺寸/时长）。
 *
 * @param bytes GIF 文件内容
 * @returns 画面信息与各帧元数据
 * @throws 不是 GIF 或数据截断时抛错
 * @example const info = parseGif(bytes); info.frames.length
 */
export function parseGif(bytes: Uint8Array): ParsedGif {
  const sig = String.fromCharCode(...Array.from(bytes.subarray(0, 6)))
  if (sig !== 'GIF87a' && sig !== 'GIF89a') throw new Error('不是有效的 GIF 文件')
  const width = u16(bytes, 6)
  const height = u16(bytes, 8)
  const flags = bytes[10]
  let p = 13
  let globalPal: Uint8Array = new Uint8Array(0)
  if (flags & 0x80) {
    const n = 3 * (1 << ((flags & 7) + 1))
    globalPal = bytes.subarray(p, p + n)
    p += n
  }
  const frames: ParsedFrame[] = []
  let loop = 1
  let gce = { disposal: 0, transparentIndex: -1, delayCs: 0 }
  while (p < bytes.length) {
    const tag = bytes[p++]
    if (tag === 0x3b) break
    if (tag === 0x21) {
      const label = bytes[p++]
      if (label === 0xf9) {
        const pk = bytes[p + 1]
        gce = { disposal: (pk >> 2) & 7, transparentIndex: pk & 1 ? bytes[p + 4] : -1, delayCs: u16(bytes, p + 2) }
      } else if (label === 0xff) {
        const name = String.fromCharCode(...Array.from(bytes.subarray(p + 1, p + 12)))
        if (name === 'NETSCAPE2.0' || name === 'ANIMEXTS1.0') {
          const sub = readSubBlocks(bytes, p + 12)
          if (sub.data[0] === 1) {
            const v = u16(sub.data, 1)
            loop = v === 0 ? 0 : v + 1
          }
        }
      }
      // 不管认不认识，整个扩展块的子块序列都跳过
      p = readSubBlocks(bytes, p).end
      continue
    }
    if (tag === 0x2c) {
      const left = u16(bytes, p)
      const top = u16(bytes, p + 2)
      const w = u16(bytes, p + 4)
      const h = u16(bytes, p + 6)
      const pk = bytes[p + 8]
      p += 9
      let palette: Uint8Array = globalPal
      if (pk & 0x80) {
        const n = 3 * (1 << ((pk & 7) + 1))
        palette = bytes.subarray(p, p + n)
        p += n
      }
      const minCodeSize = bytes[p++]
      const sub = readSubBlocks(bytes, p)
      p = sub.end
      frames.push({ left, top, w, h, interlaced: !!(pk & 0x40), palette, minCodeSize, data: sub.data, ...gce })
      gce = { disposal: 0, transparentIndex: -1, delayCs: 0 }
      continue
    }
    throw new Error('GIF 数据损坏')
  }
  return { width, height, loop, frames }
}

/** 隔行下标还原成顺序行 */
function deinterlace(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(src.length)
  let row = 0
  for (let pass = 0; pass < 4; pass++) {
    for (let y = INTERLACE_START[pass]; y < h; y += INTERLACE_STEP[pass]) {
      out.set(src.subarray(row * w, (row + 1) * w), y * w)
      row++
    }
  }
  return out
}

/**
 * 逐帧解码并按处置方式合成完整画面（生成器，用一帧取一帧，不会把所有帧同时留在内存）。
 * 每次产出的 rgba 都是新数组，调用方可自行持有。
 *
 * @param gif parseGif 的结果
 * @yields 每帧完整画面与延迟
 * @example for (const f of renderGif(parseGif(bytes))) draw(f.rgba)
 */
export function* renderGif(gif: ParsedGif): Generator<DecodedFrame> {
  const { width, height } = gif
  const canvas = new Uint8ClampedArray(width * height * 4)
  let prevRestore: Uint8ClampedArray | null = null
  let prev: ParsedFrame | null = null
  for (const f of gif.frames) {
    // 先处理上一帧的处置方式
    if (prev) {
      if (prev.disposal === 2) {
        for (let y = prev.top; y < Math.min(height, prev.top + prev.h); y++) {
          const from = (y * width + prev.left) * 4
          const to = (y * width + Math.min(width, prev.left + prev.w)) * 4
          canvas.fill(0, from, to)
        }
      } else if (prev.disposal === 3 && prevRestore) {
        canvas.set(prevRestore)
      }
    }
    prevRestore = f.disposal === 3 ? canvas.slice() : null
    let idx = lzwDecode(f.data, f.minCodeSize, f.w * f.h)
    if (f.interlaced) idx = deinterlace(idx, f.w, f.h)
    for (let y = 0; y < f.h; y++) {
      const cy = f.top + y
      if (cy >= height) break
      for (let x = 0; x < f.w; x++) {
        const cx = f.left + x
        if (cx >= width) break
        const v = idx[y * f.w + x]
        if (v === f.transparentIndex) continue
        const o = (cy * width + cx) * 4
        canvas[o] = f.palette[v * 3]
        canvas[o + 1] = f.palette[v * 3 + 1]
        canvas[o + 2] = f.palette[v * 3 + 2]
        canvas[o + 3] = 255
      }
    }
    prev = f
    yield { rgba: canvas.slice(), delayCs: f.delayCs }
  }
}

/**
 * 一次解出所有帧（帧多或画面大时请改用 renderGif 逐帧处理）。
 *
 * @param bytes GIF 文件内容
 * @returns 画面尺寸、循环次数与全部完整帧
 * @example const { frames } = decodeGif(bytes)
 */
export function decodeGif(bytes: Uint8Array): { width: number; height: number; loop: number; frames: DecodedFrame[] } {
  const info = parseGif(bytes)
  return { width: info.width, height: info.height, loop: info.loop, frames: Array.from(renderGif(info)) }
}
