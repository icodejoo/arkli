/**
 * 获取壁纸封装。对应原生 `native.wallpaper.get`，契约见 docs/design/bridge-protocol.md「获取壁纸方法」。
 *
 * 尽力读取：Android 13 及以上系统出于隐私，通常只给应用默认壁纸，甚至直接拒绝，此时返回 `available: false`。
 * 无宿主时抛 {@link NativeUnavailableError}。
 */
import { call as bridgeCall } from './bridge'
import { requireNative, type CallFn } from './system'

/** 方法名 */
export const WALLPAPER_METHOD = 'native.wallpaper.get'

/** 缓存产物的同源 URL 前缀 */
const FILES_URL_PREFIX = '/files/'

/** 读到壁纸 */
export interface WallpaperOk {
  /** 读到了 */
  available: true
  /** 缓存相对路径（PNG） */
  path: string
  /** 宽（像素），超过 2400 万像素时是缩小后的尺寸 */
  width: number
  /** 高（像素） */
  height: number
  /** current 是当前壁纸，default 是系统默认壁纸 */
  kind: 'current' | 'default'
}

/** 失败原因：restricted 系统限制，unsupported 设备不支持，error 其他错误 */
export type WallpaperReason = 'restricted' | 'unsupported' | 'error'

/** 没读到壁纸 */
export interface WallpaperFail {
  /** 没读到 */
  available: false
  /** 原因 */
  reason: WallpaperReason
  /** 原生给的简短说明 */
  message: string
}

/** 获取结果 */
export type WallpaperResult = WallpaperOk | WallpaperFail

/**
 * 获取壁纸。读取失败不会抛错，而是返回 `available: false`。
 *
 * @param call 原生调用函数，默认走 bridge（仅测试注入）
 * @returns 获取结果
 * @example const r = await getWallpaper(); if (r.available) img.src = wallpaperUrl(r.path)
 */
export async function getWallpaper(call: CallFn = bridgeCall): Promise<WallpaperResult> {
  requireNative(WALLPAPER_METHOD)
  return call<WallpaperResult>(WALLPAPER_METHOD, {}, { timeoutMs: 60_000 })
}

/**
 * 缓存相对路径转同源 URL，可直接给 `<img src>`。
 *
 * @param path 形如 `cache/out/wallpaper/wallpaper.png`
 * @returns `/files/<path>`
 * @example wallpaperUrl('cache/out/a.png') // '/files/cache/out/a.png'
 */
export function wallpaperUrl(path: string): string {
  return FILES_URL_PREFIX + path
}
