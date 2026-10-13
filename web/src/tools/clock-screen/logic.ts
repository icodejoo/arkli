// 时间屏幕：时间/日期格式化、整秒对齐定时、防烧屏偏移、农历文本（与 Vue 解耦）

/** 星期名，下标对应 Date.getDay() */
export const WEEK_NAMES = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'] as const
/** 对齐整秒时多等的毫秒数，避免提前一点触发导致显示慢一拍 */
export const TICK_PAD_MS = 20
/** 防烧屏偏移的最大像素 */
export const BURN_IN_RANGE = 6
/** 一秒的毫秒数 */
export const MS_PER_SECOND = 1000

/** 拆好的时分秒（均为两位字符串） */
export interface ClockParts {
  /** 时 */
  hh: string
  /** 分 */
  mm: string
  /** 秒 */
  ss: string
  /** 12 小时制时的上午/下午；24 小时制为空 */
  period: string
}

/** 农历库的最小结构（tyme4ts 的 SolarDay 满足它） */
export interface LunarLib {
  /** 阳历日 */
  SolarDay: {
    fromYmd(y: number, m: number, d: number): {
      getLunarDay(): { getName(): string; getLunarMonth(): { getName(): string } }
    }
  }
}

/**
 * 补零到两位。
 *
 * @param n 非负整数
 * @returns 两位字符串
 */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/**
 * 把时间拆成时分秒。
 *
 * @param d 时间
 * @param hour24 是否 24 小时制
 * @returns 两位字符串的时、分、秒；12 小时制时 0 点显示 12 并带「上午/下午」
 * @example
 * clockParts(new Date(2026, 0, 1, 15, 4, 5), true) // { hh: '15', mm: '04', ss: '05', period: '' }
 */
export function clockParts(d: Date, hour24: boolean): ClockParts {
  const h = d.getHours()
  if (hour24) return { hh: pad2(h), mm: pad2(d.getMinutes()), ss: pad2(d.getSeconds()), period: '' }
  const h12 = h % 12 === 0 ? 12 : h % 12
  return { hh: pad2(h12), mm: pad2(d.getMinutes()), ss: pad2(d.getSeconds()), period: h < 12 ? '上午' : '下午' }
}

/**
 * 格式化日期与星期。
 *
 * @param d 时间
 * @returns 如「2026年10月13日 星期二」
 */
export function formatDateLine(d: Date): string {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${WEEK_NAMES[d.getDay()]}`
}

/**
 * 到下一个整秒还要等多久。
 *
 * @param nowMs 当前时间戳（毫秒）
 * @returns 1 到 1000 之间的毫秒数（恰在整秒时返回 1000）
 * @example
 * msToNextSecond(1500) // 500
 */
export function msToNextSecond(nowMs: number): number {
  return MS_PER_SECOND - (((nowMs % MS_PER_SECOND) + MS_PER_SECOND) % MS_PER_SECOND)
}

/**
 * 启动对齐整秒的定时器：先立即回调一次，之后每到整秒回调。
 *
 * @param cb 回调，参数为当前时间
 * @param now 取当前时间戳的函数，测试可注入
 * @returns 停止函数
 * @example
 * const stop = startSecondTicker((d) => (time.value = d))
 */
export function startSecondTicker(cb: (d: Date) => void, now: () => number = Date.now): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const run = (): void => {
    if (stopped) return
    const t = now()
    cb(new Date(t))
    timer = setTimeout(run, msToNextSecond(t) + TICK_PAD_MS)
  }
  run()
  return () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 防烧屏偏移：每分钟换一个位置，只在小范围内游走。
 *
 * @param minuteIndex 分钟序号（如 Math.floor(时间戳 / 60000)）
 * @returns x、y 偏移像素，范围 [-BURN_IN_RANGE, BURN_IN_RANGE]
 */
export function burnInOffset(minuteIndex: number): { x: number; y: number } {
  const span = BURN_IN_RANGE * 2 + 1
  const m = Math.abs(Math.floor(minuteIndex))
  return { x: ((m * 5) % span) - BURN_IN_RANGE, y: ((m * 3) % span) - BURN_IN_RANGE }
}

/**
 * 取某天的农历文本。
 *
 * @param lib 农历库（动态加载的 tyme4ts）
 * @param d 时间
 * @returns 如「九月初四」；库抛错（日期越界）时返回空串
 */
export function lunarText(lib: LunarLib, d: Date): string {
  try {
    const l = lib.SolarDay.fromYmd(d.getFullYear(), d.getMonth() + 1, d.getDate()).getLunarDay()
    return `${l.getLunarMonth().getName()}${l.getName()}`
  } catch {
    return ''
  }
}
