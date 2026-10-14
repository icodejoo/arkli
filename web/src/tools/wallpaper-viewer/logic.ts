// 获取壁纸：失败原因的中文说明、文件名（纯逻辑）
import type { WallpaperFail, WallpaperOk, WallpaperReason } from '@/native/wallpaper'

/** 一条面向用户的失败说明 */
export interface FailureCopy {
  /** 标题 */
  title: string
  /** 原因说明 */
  detail: string
}

/** 替代做法提示：从相册选壁纸的截图 */
export const ALTERNATIVE_TIP = '替代做法：长按桌面进入壁纸设置，或把壁纸截图保存到相册，再用「图片压缩」等工具从相册里选。'

/** 各失败原因的说明 */
const FAILURE_COPY: Record<WallpaperReason, FailureCopy> = {
  restricted: {
    title: '系统不让应用读取壁纸',
    detail: 'Android 13 及以上出于隐私，不再允许普通应用读取当前壁纸，最多只能读到系统默认壁纸，有的机型连默认壁纸也拒绝。',
  },
  unsupported: {
    title: '本机不支持读取壁纸',
    detail: '这台设备或当前壁纸类型（如动态壁纸、厂商主题）没有开放给应用读取。',
  },
  error: {
    title: '读取壁纸失败',
    detail: '读取过程中出了点问题，可以稍后重试。',
  },
}

/**
 * 失败原因转面向用户的中文说明。
 *
 * @param r 原生返回的失败结果
 * @returns 标题与说明；未知原因按 error 处理
 * @example describeFailure({ available: false, reason: 'restricted', message: '' }).title
 */
export function describeFailure(r: WallpaperFail): FailureCopy {
  return FAILURE_COPY[r.reason] ?? FAILURE_COPY.error
}

/**
 * 成功结果的一句话描述。
 *
 * @param r 成功结果
 * @returns 如 `当前壁纸 · 1080×2400`、`系统默认壁纸 · 1080×2400`
 */
export function describeOk(r: WallpaperOk): string {
  return `${r.kind === 'default' ? '系统默认壁纸' : '当前壁纸'} · ${r.width}×${r.height}`
}

/** 补零 */
function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * 保存用的文件名，带时间避免重名。
 *
 * @param kind 壁纸类型
 * @param now 当前时间，缺省取系统时间（仅测试注入）
 * @returns 如 `wallpaper-20260101-093005.png`、`wallpaper-default-…`
 */
export function wallpaperFileName(kind: WallpaperOk['kind'], now: Date = new Date()): string {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `wallpaper-${kind === 'default' ? 'default-' : ''}${stamp}.png`
}
