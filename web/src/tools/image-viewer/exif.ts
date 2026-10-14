/**
 * 自写 JPEG EXIF 读取器：解析 APP1 / TIFF 头 / IFD0 / ExifIFD / GPS IFD，兼容大小端。
 * 只读不写，遇到任何越界或格式问题都安静地返回已解析的部分（或 null），不抛错。
 */

/** GPS 坐标 */
export interface ExifGps {
  /** 纬度，十进制度，南纬为负 */
  lat: number
  /** 经度，十进制度，西经为负 */
  lon: number
  /** 海拔（米），无则缺省 */
  alt?: number
}

/** 解析出的 EXIF 信息，缺失的字段为 undefined */
export interface ExifData {
  /** 相机厂商 */
  make?: string
  /** 相机型号 */
  model?: string
  /** 镜头型号 */
  lensModel?: string
  /** 光圈值 F */
  fNumber?: number
  /** 曝光时间（秒） */
  exposureTime?: number
  /** ISO */
  iso?: number
  /** 焦距（毫米） */
  focalLength?: number
  /** 拍摄时间原文，如 2024:05:01 12:30:00 */
  dateTimeOriginal?: string
  /** EXIF 记录的像素宽 */
  pixelWidth?: number
  /** EXIF 记录的像素高 */
  pixelHeight?: number
  /** 方向 1~8 */
  orientation?: number
  /** GPS 坐标 */
  gps?: ExifGps
}

/** TIFF 标签号 */
const TAG = {
  make: 0x010f,
  model: 0x0110,
  orientation: 0x0112,
  exifIfd: 0x8769,
  gpsIfd: 0x8825,
  exposureTime: 0x829a,
  fNumber: 0x829d,
  iso: 0x8827,
  dateTimeOriginal: 0x9003,
  focalLength: 0x920a,
  pixelWidth: 0xa002,
  pixelHeight: 0xa003,
  lensModel: 0xa434,
  gpsLatRef: 0x0001,
  gpsLat: 0x0002,
  gpsLonRef: 0x0003,
  gpsLon: 0x0004,
  gpsAltRef: 0x0005,
  gpsAlt: 0x0006,
} as const

/** TIFF 数据类型 */
const TYPE = { byte: 1, ascii: 2, short: 3, long: 4, rational: 5, undef: 7, slong: 9, srational: 10 } as const

/** 各数据类型每个元素的字节数 */
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }

/** IFD 条目字节数 */
const ENTRY_SIZE = 12
/** 防止恶意数据造成过长循环的条目数上限 */
const MAX_ENTRIES = 512
/** 单条目元素个数上限 */
const MAX_COUNT = 0xffff
/** JPEG 起始标记 */
const JPEG_SOI = 0xffd8
/** APP1 标记 */
const MARKER_APP1 = 0xffe1
/** 扫描数据起始标记，之后不会再有元数据段 */
const MARKER_SOS = 0xffda
/** "Exif\0\0" 头长度 */
const EXIF_HEADER_LEN = 6
/** "Exif" 的 ASCII */
const EXIF_MAGIC = 0x45786966
/** 字节序标记：小端 II / 大端 MM */
const ORDER_LE = 0x4949
const ORDER_BE = 0x4d4d
/** TIFF 魔数 */
const TIFF_MAGIC = 0x002a
/** 度分秒换算 */
const MINUTES_PER_DEGREE = 60
const SECONDS_PER_DEGREE = 3600

/** 读取上下文：数据视图 + TIFF 起点 + 字节序 */
interface Ctx {
  /** 数据视图 */
  view: DataView
  /** TIFF 头在 view 中的偏移 */
  base: number
  /** 是否小端 */
  le: boolean
}

/** 单个 IFD 条目的值：数字（RATIONAL 展开为 分子,分母 交替）或字符串 */
type RawValue = number[] | string

/** 在 JPEG 中找到 Exif APP1 段，返回 TIFF 头起点；没有则 -1 */
function findTiffStart(view: DataView): number {
  if (view.byteLength < 4 || view.getUint16(0) !== JPEG_SOI) return -1
  let pos = 2
  while (pos + 4 <= view.byteLength) {
    const marker = view.getUint16(pos)
    if ((marker & 0xff00) !== 0xff00 || marker === MARKER_SOS) return -1
    const len = view.getUint16(pos + 2)
    if (len < 2) return -1
    if (marker === MARKER_APP1 && pos + 4 + EXIF_HEADER_LEN <= view.byteLength) {
      if (view.getUint32(pos + 4) === EXIF_MAGIC && view.getUint16(pos + 8) === 0) return pos + 4 + EXIF_HEADER_LEN
    }
    pos += 2 + len
  }
  return -1
}

/** 读一个条目的值；类型未知或越界返回 null */
function readEntry(ctx: Ctx, entry: number): { tag: number; value: RawValue } | null {
  const { view, base, le } = ctx
  const tag = view.getUint16(entry, le)
  const type = view.getUint16(entry + 2, le)
  const count = view.getUint32(entry + 4, le)
  const unit = TYPE_SIZE[type]
  if (!unit || count > MAX_COUNT) return null
  const total = unit * count
  const dataPos = total <= 4 ? entry + 8 : base + view.getUint32(entry + 8, le)
  if (dataPos < 0 || dataPos + total > view.byteLength) return null
  if (type === TYPE.ascii) {
    let s = ''
    for (let i = 0; i < count; i++) {
      const c = view.getUint8(dataPos + i)
      if (c === 0) break
      s += String.fromCharCode(c)
    }
    return { tag, value: s.trim() }
  }
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    const p = dataPos + i * unit
    if (type === TYPE.byte || type === TYPE.undef) out.push(view.getUint8(p))
    else if (type === TYPE.short) out.push(view.getUint16(p, le))
    else if (type === TYPE.long) out.push(view.getUint32(p, le))
    else if (type === TYPE.slong) out.push(view.getInt32(p, le))
    else if (type === TYPE.rational) out.push(view.getUint32(p, le), view.getUint32(p + 4, le))
    else out.push(view.getInt32(p, le), view.getInt32(p + 4, le))
  }
  return { tag, value: out }
}

/** 读整个 IFD 为 tag→值 的表；偏移非法返回空表 */
function readIfd(ctx: Ctx, offset: number): Map<number, RawValue> {
  const map = new Map<number, RawValue>()
  const start = ctx.base + offset
  if (offset <= 0 || start + 2 > ctx.view.byteLength) return map
  const n = Math.min(ctx.view.getUint16(start, ctx.le), MAX_ENTRIES)
  for (let i = 0; i < n; i++) {
    const p = start + 2 + i * ENTRY_SIZE
    if (p + ENTRY_SIZE > ctx.view.byteLength) break
    const e = readEntry(ctx, p)
    if (e) map.set(e.tag, e.value)
  }
  return map
}

/** 取字符串值，空串视为没有 */
function str(m: Map<number, RawValue>, tag: number): string | undefined {
  const v = m.get(tag)
  return typeof v === 'string' && v ? v : undefined
}

/** 取第 i 个整数值 */
function int(m: Map<number, RawValue>, tag: number, i = 0): number | undefined {
  const v = m.get(tag)
  return Array.isArray(v) && v.length > i ? v[i] : undefined
}

/** 取第 i 个有理数值（分母为 0 视为没有） */
function rational(m: Map<number, RawValue>, tag: number, i = 0): number | undefined {
  const v = m.get(tag)
  if (!Array.isArray(v) || v.length < (i + 1) * 2) return undefined
  const den = v[i * 2 + 1]
  return den === 0 ? undefined : v[i * 2] / den
}

/** 度分秒三个有理数转十进制度 */
function dms(m: Map<number, RawValue>, tag: number): number | undefined {
  const d = rational(m, tag, 0)
  const mi = rational(m, tag, 1)
  const s = rational(m, tag, 2)
  if (d === undefined || mi === undefined || s === undefined) return undefined
  return d + mi / MINUTES_PER_DEGREE + s / SECONDS_PER_DEGREE
}

/** 解析 GPS IFD */
function parseGps(m: Map<number, RawValue>): ExifGps | undefined {
  const lat = dms(m, TAG.gpsLat)
  const lon = dms(m, TAG.gpsLon)
  if (lat === undefined || lon === undefined) return undefined
  const alt = rational(m, TAG.gpsAlt)
  const below = int(m, TAG.gpsAltRef) === 1
  return {
    lat: str(m, TAG.gpsLatRef)?.toUpperCase() === 'S' ? -lat : lat,
    lon: str(m, TAG.gpsLonRef)?.toUpperCase() === 'W' ? -lon : lon,
    alt: alt === undefined ? undefined : below ? -alt : alt,
  }
}

/**
 * 从 JPEG 字节中读取 EXIF。
 *
 * @param bytes 完整 JPEG 文件（只需包含到 APP1 段，前 128KB 通常足够）
 * @returns EXIF 信息；不是 JPEG、没有 EXIF 或一个字段都读不出时返回 null
 * @example
 * const info = parseExif(new Uint8Array(await file.arrayBuffer()))
 * console.log(info?.model, info?.fNumber)
 */
export function parseExif(bytes: Uint8Array): ExifData | null {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const base = findTiffStart(view)
    if (base < 0 || base + 8 > view.byteLength) return null
    const order = view.getUint16(base)
    if (order !== ORDER_LE && order !== ORDER_BE) return null
    const ctx: Ctx = { view, base, le: order === ORDER_LE }
    if (view.getUint16(base + 2, ctx.le) !== TIFF_MAGIC) return null
    const ifd0 = readIfd(ctx, view.getUint32(base + 4, ctx.le))
    const exifOff = int(ifd0, TAG.exifIfd)
    const gpsOff = int(ifd0, TAG.gpsIfd)
    const sub = exifOff ? readIfd(ctx, exifOff) : new Map<number, RawValue>()
    const gpsMap = gpsOff ? readIfd(ctx, gpsOff) : new Map<number, RawValue>()
    const data: ExifData = {
      make: str(ifd0, TAG.make),
      model: str(ifd0, TAG.model),
      orientation: int(ifd0, TAG.orientation),
      lensModel: str(sub, TAG.lensModel),
      fNumber: rational(sub, TAG.fNumber),
      exposureTime: rational(sub, TAG.exposureTime),
      iso: int(sub, TAG.iso),
      focalLength: rational(sub, TAG.focalLength),
      dateTimeOriginal: str(sub, TAG.dateTimeOriginal),
      pixelWidth: int(sub, TAG.pixelWidth),
      pixelHeight: int(sub, TAG.pixelHeight),
      gps: parseGps(gpsMap),
    }
    const hasAny = (Object.keys(data) as Array<keyof ExifData>).some((k) => data[k] !== undefined)
    return hasAny ? data : null
  } catch {
    return null
  }
}
