// 房贷计算：等额本息 / 等额本金 / 组合贷
// 取整规则：所有金额以"整数分"存储与累加；逐月利息 = round(剩余本金分 × 月利率)，四舍五入到分；
// 等额本息月供先按公式算出再四舍五入到分；最后一期本金 = 剩余本金，把累计尾差并入最后一期，
// 因此各期本金之和精确等于贷款额，不会差一分。

/** 还款方式：equal-payment 等额本息，equal-principal 等额本金 */
export type RepayMethod = 'equal-payment' | 'equal-principal'

/** 一笔贷款的输入 */
export interface LoanInput {
  /** 贷款本金，单位：分（整数） */
  principalCents: number
  /** 年利率，百分数，如 3.5 表示 3.5% */
  annualRatePct: number
  /** 还款期数（月） */
  months: number
}

/** 还款表的一行 */
export interface ScheduleRow {
  /** 期数，从 1 开始 */
  period: number
  /** 当期还款额（分） */
  payment: number
  /** 其中本金（分） */
  principal: number
  /** 其中利息（分） */
  interest: number
  /** 还款后剩余本金（分） */
  balance: number
}

/** 计算结果 */
export interface LoanResult {
  /** 逐月还款表 */
  rows: ScheduleRow[]
  /** 首月还款额（分） */
  firstPayment: number
  /** 末月还款额（分） */
  lastPayment: number
  /** 总利息（分） */
  totalInterest: number
  /** 总还款（分） */
  totalPayment: number
}

/** 一年的月数 */
export const MONTHS_PER_YEAR = 12
/** 最长期限（年） */
export const MAX_YEARS = 30
/** 一元等于多少分 */
const CENTS_PER_YUAN = 100
/** 利率上限（百分数），防止误输入 */
const MAX_RATE_PCT = 100

/**
 * 元转分（四舍五入）。
 *
 * @param yuan 金额，单位元
 * @returns 整数分
 * @example
 * yuanToCents(12.345) // 1235
 */
export function yuanToCents(yuan: number): number {
  return Math.round(yuan * CENTS_PER_YUAN)
}

/**
 * 分格式化成带千分位的元字符串，固定两位小数。
 *
 * @param cents 整数分
 * @returns 如 "1,234.50"
 * @example
 * formatCents(123450) // "1,234.50"
 */
export function formatCents(cents: number): string {
  const neg = cents < 0
  const abs = Math.abs(Math.round(cents))
  const yuan = Math.floor(abs / CENTS_PER_YUAN)
  const frac = String(abs % CENTS_PER_YUAN).padStart(2, '0')
  const int = String(yuan).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${neg ? '-' : ''}${int}.${frac}`
}

/** 校验单笔贷款输入，不合法抛 RangeError */
function validate(loan: LoanInput): void {
  if (!Number.isInteger(loan.principalCents) || loan.principalCents <= 0) throw new RangeError('贷款金额必须大于 0')
  if (!Number.isInteger(loan.months) || loan.months < 1 || loan.months > MAX_YEARS * MONTHS_PER_YEAR) {
    throw new RangeError(`期限须在 1 到 ${MAX_YEARS * MONTHS_PER_YEAR} 个月之间`)
  }
  if (!Number.isFinite(loan.annualRatePct) || loan.annualRatePct < 0 || loan.annualRatePct > MAX_RATE_PCT) {
    throw new RangeError('利率须在 0 到 100 之间')
  }
}

/**
 * 计算单笔贷款的还款表。
 *
 * @param loan 贷款输入（本金分、年利率%、期数）
 * @param method 还款方式
 * @returns 还款表与汇总；输入不合法时抛 RangeError
 * @example
 * const r = calcLoan({ principalCents: 100000000, annualRatePct: 3.5, months: 360 }, 'equal-payment')
 * formatCents(r.firstPayment) // "4,490.45"
 */
export function calcLoan(loan: LoanInput, method: RepayMethod): LoanResult {
  validate(loan)
  const { principalCents: P, months: n } = loan
  const r = loan.annualRatePct / 100 / MONTHS_PER_YEAR
  // 等额本息固定月供；利率为 0 时退化为平均分摊
  const fixedPay = r === 0 ? Math.round(P / n) : Math.round((P * r) / (1 - Math.pow(1 + r, -n)))
  // 等额本金每期应还本金（向下取整，余数并入最后一期）
  const basePrincipal = Math.floor(P / n)
  const rows: ScheduleRow[] = []
  let balance = P
  let totalInterest = 0
  for (let k = 1; k <= n; k++) {
    const interest = Math.round(balance * r)
    let principal: number
    if (k === n) principal = balance
    else if (method === 'equal-payment') principal = Math.min(fixedPay - interest, balance)
    else principal = basePrincipal
    balance -= principal
    totalInterest += interest
    rows.push({ period: k, payment: principal + interest, principal, interest, balance })
  }
  return {
    rows,
    firstPayment: rows[0].payment,
    lastPayment: rows[n - 1].payment,
    totalInterest,
    totalPayment: P + totalInterest,
  }
}

/**
 * 计算组合贷（多笔贷款按期数逐月相加）。
 *
 * @param loans 贷款列表（通常是商贷 + 公积金），至少一笔
 * @param method 还款方式，各笔共用
 * @returns 合并后的还款表；某笔先还清后，后续月份只算剩下的
 * @example
 * calcCombined([
 *   { principalCents: 50000000, annualRatePct: 3.5, months: 360 },
 *   { principalCents: 30000000, annualRatePct: 2.85, months: 300 },
 * ], 'equal-payment').rows.length // 360
 */
export function calcCombined(loans: LoanInput[], method: RepayMethod): LoanResult {
  if (loans.length === 0) throw new RangeError('至少需要一笔贷款')
  const parts = loans.map((l) => calcLoan(l, method))
  const total = Math.max(...parts.map((p) => p.rows.length))
  const rows: ScheduleRow[] = []
  for (let k = 0; k < total; k++) {
    const row: ScheduleRow = { period: k + 1, payment: 0, principal: 0, interest: 0, balance: 0 }
    for (const p of parts) {
      const x = p.rows[k]
      if (!x) continue
      row.payment += x.payment
      row.principal += x.principal
      row.interest += x.interest
      row.balance += x.balance
    }
    rows.push(row)
  }
  return {
    rows,
    firstPayment: rows[0].payment,
    lastPayment: rows[total - 1].payment,
    totalInterest: parts.reduce((s, p) => s + p.totalInterest, 0),
    totalPayment: parts.reduce((s, p) => s + p.totalPayment, 0),
  }
}
