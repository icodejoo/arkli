// 个税与年终奖估算：按 2024 年起施行的规则，规则变动请以税务机关为准。
// 金额一律用整数分运算；税额 = round(应纳税所得额 × 税率) - 速算扣除数。

/** 规则说明，页面与注释共用 */
export const RULE_NOTE = '按 2024 年起施行的规则估算，规则变动请以税务机关为准。'
/** 每月基本减除费用（元），全年 6 万 */
export const MONTHLY_THRESHOLD_YUAN = 5000
/** 一年的月数 */
export const MONTHS = 12
/** 每元的分数 */
const CENTS = 100

/** 税率档 */
export interface TaxBracket {
  /** 本档上限（元，含），最后一档为 Infinity */
  upTo: number
  /** 税率，百分数整数 */
  ratePct: number
  /** 速算扣除数（元） */
  quick: number
}

/** 综合所得年度税率表 */
export const ANNUAL_BRACKETS: TaxBracket[] = [
  { upTo: 36000, ratePct: 3, quick: 0 },
  { upTo: 144000, ratePct: 10, quick: 2520 },
  { upTo: 300000, ratePct: 20, quick: 16920 },
  { upTo: 420000, ratePct: 25, quick: 31920 },
  { upTo: 660000, ratePct: 30, quick: 52920 },
  { upTo: 960000, ratePct: 35, quick: 85920 },
  { upTo: Infinity, ratePct: 45, quick: 181920 },
]

/** 年终奖单独计税用的月度税率表 */
export const MONTHLY_BRACKETS: TaxBracket[] = [
  { upTo: 3000, ratePct: 3, quick: 0 },
  { upTo: 12000, ratePct: 10, quick: 210 },
  { upTo: 25000, ratePct: 20, quick: 1410 },
  { upTo: 35000, ratePct: 25, quick: 2660 },
  { upTo: 55000, ratePct: 30, quick: 4410 },
  { upTo: 80000, ratePct: 35, quick: 7160 },
  { upTo: Infinity, ratePct: 45, quick: 15160 },
]

/**
 * 按税率表计算税额。
 *
 * @param taxableCents 应纳税所得额（分），小于等于 0 视为 0
 * @param brackets 税率表（元为单位的上限）
 * @returns 税额（分）
 * @example calcByBrackets(12000000, ANNUAL_BRACKETS) // 948000
 */
export function calcByBrackets(taxableCents: number, brackets: TaxBracket[]): number {
  if (taxableCents <= 0) return 0
  const b = brackets.find((x) => taxableCents <= x.upTo * CENTS)!
  return Math.round((taxableCents * b.ratePct) / 100) - b.quick * CENTS
}

/** 工资输入 */
export interface SalaryInput {
  /** 月薪税前（分） */
  monthlyCents: number
  /** 每月五险一金个人部分（分） */
  insuranceCents: number
  /** 每月专项附加扣除合计（分） */
  specialCents: number
}

/** 工资部分结果 */
export interface SalaryResult {
  /** 全年应纳税所得额（分，不为负） */
  taxableCents: number
  /** 全年应纳税额（分） */
  taxCents: number
  /** 全年税后（分） */
  afterTaxCents: number
}

/**
 * 估算全年工资薪金个税（12 个月薪资相同，不含年终奖）。
 *
 * @param input 工资输入
 * @returns 全年应税所得、税额与税后
 */
export function calcSalaryTax(input: SalaryInput): SalaryResult {
  const gross = input.monthlyCents * MONTHS
  const deduct = (MONTHLY_THRESHOLD_YUAN * CENTS + input.insuranceCents + input.specialCents) * MONTHS
  const taxableCents = Math.max(0, gross - deduct)
  const taxCents = calcByBrackets(taxableCents, ANNUAL_BRACKETS)
  return { taxableCents, taxCents, afterTaxCents: gross - input.insuranceCents * MONTHS - taxCents }
}

/**
 * 年终奖单独计税：奖金除以 12 按月度税率表找档，再用全额乘税率减速算扣除数。
 *
 * @param bonusCents 年终奖（分）
 * @returns 税额（分）
 */
export function calcBonusSeparate(bonusCents: number): number {
  if (bonusCents <= 0) return 0
  const b = MONTHLY_BRACKETS.find((x) => bonusCents / MONTHS <= x.upTo * CENTS)!
  return Math.round((bonusCents * b.ratePct) / 100) - b.quick * CENTS
}

/**
 * 年终奖并入综合所得：并入后全年税额减去不含奖金时的税额。
 *
 * @param salary 工资结果
 * @param bonusCents 年终奖（分）
 * @returns 奖金部分增加的税额（分）
 */
export function calcBonusCombined(salary: SalaryResult, bonusCents: number): number {
  if (bonusCents <= 0) return 0
  return calcByBrackets(salary.taxableCents + bonusCents, ANNUAL_BRACKETS) - salary.taxCents
}

/** 两种年终奖计税方式的对比 */
export interface BonusCompare {
  /** 单独计税税额（分） */
  separateCents: number
  /** 并入综合所得增加的税额（分） */
  combinedCents: number
  /** 更省税的方式 */
  better: 'separate' | 'combined' | 'same'
}

/**
 * 对比年终奖两种计税方式。
 *
 * @param salary 工资结果
 * @param bonusCents 年终奖（分）
 * @returns 对比结果
 */
export function compareBonus(salary: SalaryResult, bonusCents: number): BonusCompare {
  const separateCents = calcBonusSeparate(bonusCents)
  const combinedCents = calcBonusCombined(salary, bonusCents)
  const better = separateCents === combinedCents ? 'same' : separateCents < combinedCents ? 'separate' : 'combined'
  return { separateCents, combinedCents, better }
}
