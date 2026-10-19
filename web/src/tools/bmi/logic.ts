// BMI 与基础代谢：BMI 分级用中国成人标准，BMR 用 Mifflin-St Jeor 公式。仅供参考，不能替代医学诊断。

/** 性别 */
export type Sex = 'male' | 'female'

/** 偏瘦上限（不含） */
const UNDERWEIGHT_MAX = 18.5
/** 正常上限（不含） */
const NORMAL_MAX = 24
/** 超重上限（不含） */
const OVERWEIGHT_MAX = 28
/** 厘米每米 */
const CM_PER_M = 100

/** 活动水平及系数 */
export const ACTIVITY_LEVELS = [
  { key: 'sedentary', label: '几乎不运动（久坐）', factor: 1.2 },
  { key: 'light', label: '轻度（每周运动 1~3 次）', factor: 1.375 },
  { key: 'moderate', label: '中度（每周运动 3~5 次）', factor: 1.55 },
  { key: 'heavy', label: '重度（每周运动 6~7 次）', factor: 1.725 },
  { key: 'extreme', label: '极重（体力劳动或每天两练）', factor: 1.9 },
] as const

/**
 * 计算 BMI。
 *
 * @param heightCm 身高，厘米
 * @param weightKg 体重，公斤
 * @returns BMI，保留 1 位小数；输入非正数返回 null
 * @example calcBmi(170, 65) // 22.5
 */
export function calcBmi(heightCm: number, weightKg: number): number | null {
  if (!(heightCm > 0) || !(weightKg > 0)) return null
  const m = heightCm / CM_PER_M
  return Math.round((weightKg / (m * m)) * 10) / 10
}

/**
 * 中国成人 BMI 分级。
 *
 * @param bmi BMI 值
 * @returns 偏瘦 / 正常 / 超重 / 肥胖
 */
export function bmiLevel(bmi: number): '偏瘦' | '正常' | '超重' | '肥胖' {
  if (bmi < UNDERWEIGHT_MAX) return '偏瘦'
  if (bmi < NORMAL_MAX) return '正常'
  if (bmi < OVERWEIGHT_MAX) return '超重'
  return '肥胖'
}

/**
 * 正常 BMI 范围（18.5 ~ 23.9）对应的体重区间。
 *
 * @param heightCm 身高，厘米
 * @returns [最低, 最高] 公斤，保留 1 位小数
 */
export function normalWeightRange(heightCm: number): [number, number] {
  const m2 = (heightCm / CM_PER_M) ** 2
  return [Math.round(UNDERWEIGHT_MAX * m2 * 10) / 10, Math.round((NORMAL_MAX - 0.1) * m2 * 10) / 10]
}

/**
 * Mifflin-St Jeor 基础代谢率。
 *
 * @param sex 性别
 * @param age 年龄（岁）
 * @param heightCm 身高，厘米
 * @param weightKg 体重，公斤
 * @returns 千卡/天，四舍五入取整
 * @example calcBmr('male', 30, 175, 70) // 1649
 */
export function calcBmr(sex: Sex, age: number, heightCm: number, weightKg: number): number {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age
  return Math.round(base + (sex === 'male' ? 5 : -161))
}

/**
 * 每日总能耗估算。
 *
 * @param bmr 基础代谢
 * @param factor 活动系数
 * @returns 千卡/天，取整
 */
export function calcTdee(bmr: number, factor: number): number {
  return Math.round(bmr * factor)
}
