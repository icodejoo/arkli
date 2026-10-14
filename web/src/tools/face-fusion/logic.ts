/** 融合比例默认值（图 B 的占比） */
export const DEFAULT_RATIO = 0.5
/** 比例滑杆步进 */
export const RATIO_STEP = 0.05
/** 图片最长边上限（原生侧识别人脸前会处理，这里只拦明显不合理的输入） */
export const MAX_SIDE = 8000

/** 待校验的图片信息 */
export interface FuseInput {
  /** 缓存路径或预览地址，有值才算已选 */
  url?: string
  /** 宽 */
  width: number
  /** 高 */
  height: number
}

/**
 * 夹紧融合比例到 0~1，并对齐步进。
 *
 * @param v 输入值
 * @returns 0~1 的比例；非数字返回默认值
 * @example clampRatio(1.7) // 1
 */
export function clampRatio(v: number): number {
  if (!isFinite(v)) return DEFAULT_RATIO
  const c = Math.min(1, Math.max(0, v))
  return Math.min(1, +(Math.round(c / RATIO_STEP) * RATIO_STEP).toFixed(2))
}

/**
 * 比例文案：图 A 与图 B 各占多少。
 *
 * @param ratio 图 B 的占比 0~1
 * @returns 如 `图 A 70% · 图 B 30%`
 * @example ratioText(0.3) // '图 A 70% · 图 B 30%'
 */
export function ratioText(ratio: number): string {
  const b = Math.round(clampRatio(ratio) * 100)
  return `图 A ${100 - b}% · 图 B ${b}%`
}

/**
 * 校验融合输入。
 *
 * @param a 图 A
 * @param b 图 B
 * @param ratio 融合比例
 * @returns 第一个问题的中文提示；全部通过返回 null
 * @example validateFuse(null, null, 0.5) // '请先选择图 A'
 */
export function validateFuse(a: FuseInput | null, b: FuseInput | null, ratio: number): string | null {
  if (!a || !a.url) return '请先选择图 A'
  if (!b || !b.url) return '请再选择图 B'
  for (const [name, im] of [['图 A', a], ['图 B', b]] as Array<[string, FuseInput]>) {
    if (Math.max(im.width, im.height) > MAX_SIDE) return `${name}尺寸过大，请先缩小`
  }
  if (!isFinite(ratio) || ratio < 0 || ratio > 1) return '融合比例需在 0~1 之间'
  return null
}
