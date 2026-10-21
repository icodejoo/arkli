import floatIcon from '@/assets/icons/picture-in-picture-2.svg?raw'
import link from '@/assets/icons/link.svg?raw'
import pkg from '@/assets/icons/package.svg?raw'
import refresh from '@/assets/icons/refresh-cw.svg?raw'
import settings from '@/assets/icons/settings.svg?raw'
import share from '@/assets/icons/share-2.svg?raw'
import smartphone from '@/assets/icons/smartphone.svg?raw'
import star from '@/assets/icons/star.svg?raw'
import starOff from '@/assets/icons/star-off.svg?raw'
import {
  ICON_FLOAT,
  ICON_LINK,
  ICON_PACKAGE,
  ICON_REFRESH,
  ICON_SETTINGS,
  ICON_SHARE,
  ICON_SMARTPHONE,
  ICON_STAR,
  ICON_STAR_OFF,
} from './pinToolSheet'

/** svg 里跟随文字色的占位色 */
const CURRENT_COLOR = 'currentColor'
/** svg data URI 前缀（van-share-sheet 的 icon 只认图片地址，所以把彩色 svg 内联成 data URI） */
const SVG_DATA_URI_PREFIX = 'data:image/svg+xml;charset=utf-8,'

/** 一个面板图标：Lucide 原始 svg 与它的主题色 */
interface ShareIconDef {
  /** Lucide svg 文本（描边用 currentColor） */
  svg: string
  /** 图标色 */
  color: string
}

/** 面板图标表：键为 pinToolSheet.ts 的 ICON_*，颜色在亮暗底色上都够醒目 */
const SHARE_ICONS: Record<string, ShareIconDef> = {
  [ICON_SHARE]: { svg: share, color: '#2f80ed' },
  [ICON_PACKAGE]: { svg: pkg, color: '#27ae60' },
  [ICON_STAR]: { svg: star, color: '#f2a413' },
  [ICON_STAR_OFF]: { svg: starOff, color: '#f2a413' },
  [ICON_SMARTPHONE]: { svg: smartphone, color: '#12b5a6' },
  [ICON_FLOAT]: { svg: floatIcon, color: '#d6409f' },
  [ICON_REFRESH]: { svg: refresh, color: '#8e5bd9' },
  [ICON_LINK]: { svg: link, color: '#eb6a3a' },
  [ICON_SETTINGS]: { svg: settings, color: '#5b6b8c' },
}

/**
 * 把面板图标名转成彩色 svg 的 data URI，供 `van-share-sheet` 的 `icon` 字段使用。
 *
 * @param name 图标名（pinToolSheet.ts 的 `ICON_*`）
 * @returns data URI；未登记的名字原样返回
 * @example
 * shareIconSrc('link') // 'data:image/svg+xml;charset=utf-8,%3Csvg...'
 */
export function shareIconSrc(name: string): string {
  const def = SHARE_ICONS[name]
  if (!def) return name
  return SVG_DATA_URI_PREFIX + encodeURIComponent(def.svg.split(CURRENT_COLOR).join(def.color))
}
