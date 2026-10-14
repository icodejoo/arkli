import { formatBytes } from '@/shared/image-calc'
import type { ExifData, ExifGps } from './exif'

/** 识别出的图片格式 */
export type ImageKind = 'jpeg' | 'png' | 'webp' | 'gif' | 'unknown'

/** 展示用的一行信息 */
export interface InfoRow {
  /** 名称 */
  label: string
  /** 值 */
  value: string
}

/** 曝光时间短于该秒数时写成 1/N 形式 */
const EXPOSURE_FRACTION_LIMIT = 0.5
/** 坐标保留的小数位 */
const GPS_DIGITS = 6
/** 读取 EXIF 时最多取文件头多少字节（APP1 段上限 64KB，留余量） */
export const EXIF_READ_BYTES = 128 * 1024

/**
 * 按文件头魔数识别格式，不依赖扩展名。
 *
 * @param bytes 文件开头若干字节（至少 12 字节更准）
 * @returns 图片格式，认不出为 unknown
 * @example detectKind(new Uint8Array([0xff, 0xd8, 0xff])) // 'jpeg'
 */
export function detectKind(bytes: Uint8Array): ImageKind {
  const at = (i: number) => bytes[i] ?? -1
  if (at(0) === 0xff && at(1) === 0xd8) return 'jpeg'
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'png'
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return 'gif'
  // RIFF....WEBP
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) {
    return 'webp'
  }
  return 'unknown'
}

/**
 * 格式显示名。
 *
 * @param kind 格式
 * @returns 如 `JPEG`；未知返回 `未知`
 */
export function kindLabel(kind: ImageKind): string {
  const map: Record<ImageKind, string> = { jpeg: 'JPEG', png: 'PNG', webp: 'WebP', gif: 'GIF', unknown: '未知' }
  return map[kind]
}

/**
 * 光圈显示。
 *
 * @param f 光圈值
 * @returns 如 `f/1.8`；整数光圈不带小数（`f/8`）
 * @example formatAperture(1.8) // 'f/1.8'
 */
export function formatAperture(f: number): string {
  return `f/${Number.isInteger(f) ? f : Number(f.toFixed(1))}`
}

/**
 * 快门显示：慢于 0.5 秒写小数秒，其余写 1/N。
 *
 * @param sec 曝光秒数
 * @returns 如 `1/250 s`、`2 s`
 * @example formatExposure(0.004) // '1/250 s'
 */
export function formatExposure(sec: number): string {
  if (sec <= 0) return '—'
  if (sec >= EXPOSURE_FRACTION_LIMIT) return `${Number(sec.toFixed(1))} s`
  return `1/${Math.round(1 / sec)} s`
}

/**
 * 焦距显示。
 *
 * @param mm 毫米
 * @returns 如 `26 mm`、`4.3 mm`
 */
export function formatFocal(mm: number): string {
  return `${Number(mm.toFixed(1))} mm`
}

/**
 * EXIF 时间转可读：`2024:05:01 12:30:00` -> `2024-05-01 12:30:00`。
 *
 * @param raw EXIF 原文
 * @returns 格式化后的字符串；不符合格式时原样返回
 */
export function formatExifDate(raw: string): string {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(raw)
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}` : raw
}

/**
 * GPS 坐标显示为十进制度，带南北东西标记。
 *
 * @param gps 坐标
 * @returns 如 `31.230416°N, 121.473701°E`
 * @example formatGps({ lat: -33.5, lon: 151.2 }) // '33.500000°S, 151.200000°E'
 */
export function formatGps(gps: ExifGps): string {
  const lat = `${Math.abs(gps.lat).toFixed(GPS_DIGITS)}°${gps.lat < 0 ? 'S' : 'N'}`
  const lon = `${Math.abs(gps.lon).toFixed(GPS_DIGITS)}°${gps.lon < 0 ? 'W' : 'E'}`
  return `${lat}, ${lon}`
}

/**
 * 相机名：型号已含厂商时不重复拼接。
 *
 * @param make 厂商
 * @param model 型号
 * @returns 如 `Canon EOS R5`；都没有返回空串
 * @example cameraName('Apple', 'iPhone 15') // 'Apple iPhone 15'
 */
export function cameraName(make?: string, model?: string): string {
  if (!model) return make ?? ''
  if (!make) return model
  return model.toLowerCase().indexOf(make.toLowerCase()) === 0 ? model : `${make} ${model}`
}

/**
 * 把基础信息 + EXIF 整理成展示行（不含 GPS，GPS 单独折叠展示）。
 *
 * @param base 文件名、格式、字节数、宽高
 * @param exif 解析出的 EXIF，可为 null
 * @returns 信息行，缺失字段不出现
 * @example buildRows({ name: 'a.jpg', kind: 'jpeg', size: 1024, width: 4, height: 3 }, null)
 */
export function buildRows(
  base: { name: string; kind: ImageKind; size: number; width: number; height: number },
  exif: ExifData | null,
): InfoRow[] {
  const rows: InfoRow[] = [
    { label: '文件名', value: base.name },
    { label: '格式', value: kindLabel(base.kind) },
    { label: '体积', value: formatBytes(base.size) },
  ]
  if (base.width && base.height) rows.push({ label: '尺寸', value: `${base.width} × ${base.height}` })
  if (!exif) return rows
  const cam = cameraName(exif.make, exif.model)
  if (cam) rows.push({ label: '相机', value: cam })
  if (exif.lensModel) rows.push({ label: '镜头', value: exif.lensModel })
  if (exif.fNumber) rows.push({ label: '光圈', value: formatAperture(exif.fNumber) })
  if (exif.exposureTime) rows.push({ label: '快门', value: formatExposure(exif.exposureTime) })
  if (exif.iso) rows.push({ label: 'ISO', value: String(exif.iso) })
  if (exif.focalLength) rows.push({ label: '焦距', value: formatFocal(exif.focalLength) })
  if (exif.dateTimeOriginal) rows.push({ label: '拍摄时间', value: formatExifDate(exif.dateTimeOriginal) })
  return rows
}
