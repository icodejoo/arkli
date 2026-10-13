/** 默认图标：映射表里没有的工具用它 */
export const DEFAULT_ICON = '🧰'

/** 工具 id 到 emoji 图标的映射（registry 不带图标，这里补） */
const ICONS: Record<string, string> = {
  'bridge-probe': '📡',
  'money-upper': '💴',
  'base-convert': '🔢',
  'unit-convert': '📏',
  'time-calc': '⏱️',
  'date-calc': '📅',
  'lunar-convert': '🌙',
  kinship: '👪',
  'coin-flip': '💰',
  dice: '🎲',
  lottery: '🎟️',
  decide: '🎡',
  base64: '🔐',
  'password-gen': '🔑',
  'color-convert': '🎨',
  ruler: '📏',
  compass: '🧭',
  'clock-screen': '🕒',
  danmaku: '📣',
  'device-info': '📱',
  'image-compress': '🗜️',
  'image-stitch': '🧩',
  'image-grid': '🔳',
  hash: '🧬',
  pinyin: '🈶',
  'qrcode-gen': '🏷️',
}

/**
 * 取工具图标。
 *
 * @param id 工具 id
 * @returns emoji；未登记时为默认图标
 * @example
 * toolIcon('dice') // '🎲'
 */
export function toolIcon(id: string): string {
  return ICONS[id] ?? DEFAULT_ICON
}
