// 小费 / AA 分账 / 折扣：金额一律为整数分，分摊时余数逐分分给靠前的人，保证合计精确

/** 折扣率的满额（10 折） */
const FULL_ZHE_TENTHS = 100

/**
 * 把总额均分给 n 份，余数每份多 1 分，靠前的先分。
 *
 * @param totalCents 总额（分，整数）
 * @param n 份数，需为正整数
 * @returns 每份金额（分），合计等于总额
 * @example splitCents(100, 3) // [34, 33, 33]
 */
export function splitCents(totalCents: number, n: number): number[] {
  const base = Math.trunc(totalCents / n)
  const rest = totalCents - base * n
  return Array.from({ length: n }, (_, i) => base + (i < rest ? 1 : 0))
}

/** 小费结果 */
export interface TipResult {
  /** 小费（分） */
  tipCents: number
  /** 含小费总额（分） */
  totalCents: number
  /** 每人应付（分），合计等于总额 */
  perPerson: number[]
}

/**
 * 计算小费与人均。
 *
 * @param amountCents 账单金额（分）
 * @param tipPct 小费比例，百分数，可带小数
 * @param people 人数，正整数
 * @returns 小费结果
 * @example calcTip(10000, 15, 2) // tip 1500, total 11500
 */
export function calcTip(amountCents: number, tipPct: number, people: number): TipResult {
  const tipCents = Math.round((amountCents * tipPct) / 100)
  const totalCents = amountCents + tipCents
  return { tipCents, totalCents, perPerson: splitCents(totalCents, people) }
}

/** AA 项目 */
export interface AaItem {
  /** 项目名 */
  name: string
  /** 金额（分） */
  cents: number
  /** 参与者在成员列表里的下标 */
  members: number[]
}

/**
 * AA 分账：每个项目只在参与者之间均摊，累加到每个成员。
 *
 * @param memberCount 成员数
 * @param items 项目列表；无参与者的项目被忽略
 * @returns 每个成员应付（分）
 * @example calcAa(3, [{ name: '饭', cents: 9000, members: [0, 1, 2] }])
 */
export function calcAa(memberCount: number, items: AaItem[]): number[] {
  const owe = new Array<number>(memberCount).fill(0)
  for (const it of items) {
    const ms = [...new Set(it.members)].filter((m) => m >= 0 && m < memberCount).sort((a, b) => a - b)
    if (!ms.length || it.cents <= 0) continue
    splitCents(it.cents, ms.length).forEach((c, i) => {
      owe[ms[i]] += c
    })
  }
  return owe
}

/** 折扣输入 */
export interface DiscountInput {
  /** 原价（分） */
  originalCents: number
  /** 折扣，如 8.5 表示 8.5 折；10 或空表示不打折 */
  zhe: number
  /** 立减金额（分） */
  reduceCents: number
  /** 叠加顺序：先打折再立减，或先立减再打折 */
  order: 'rate-first' | 'reduce-first'
}

/** 折扣结果 */
export interface DiscountResult {
  /** 实付（分，不为负） */
  finalCents: number
  /** 省下的钱（分） */
  savedCents: number
  /** 综合折扣（折），保留 2 位小数；原价为 0 时为 10 */
  effectiveZhe: number
}

/** 按折扣计算价格，zhe 先转成"十分之一折"整数 */
function applyZhe(cents: number, zhe: number): number {
  const tenths = Math.round(zhe * 10)
  return Math.round((cents * tenths) / FULL_ZHE_TENTHS)
}

/**
 * 计算折扣叠加后的实付。
 *
 * @param input 折扣输入
 * @returns 实付、节省与综合折扣
 * @example calcDiscount({ originalCents: 10000, zhe: 8, reduceCents: 1000, order: 'rate-first' }) // 实付 7000
 */
export function calcDiscount(input: DiscountInput): DiscountResult {
  const { originalCents: o, zhe, reduceCents: r, order } = input
  const z = zhe > 0 && zhe < 10 ? zhe : 10
  const raw = order === 'rate-first' ? applyZhe(o, z) - r : applyZhe(o - r, z)
  const finalCents = Math.max(0, raw)
  const effectiveZhe = o > 0 ? Math.round((finalCents / o) * 1000) / 100 : 10
  return { finalCents, savedCents: o - finalCents, effectiveZhe }
}
