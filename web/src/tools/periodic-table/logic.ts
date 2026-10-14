// 元素周期表逻辑：网格位置、族/周期、电子排布、搜索、质量格式化
import { ELEMENTS, type Element } from './data'

/** 网格位置：行、列都从 1 开始 */
export interface GridPos {
  /** 行（1~7 为主表，9、10 为镧系/锕系，8 是空隙行） */
  row: number
  /** 列（1~18） */
  col: number
}

/** 镧系元素起止序号 */
const LANTHANIDE_START = 57
const LANTHANIDE_END = 71
/** 锕系元素起止序号 */
const ACTINIDE_START = 89
const ACTINIDE_END = 103
/** 镧系行、锕系行在网格中的行号（第 8 行留作空隙） */
export const LANTHANIDE_ROW = 9
export const ACTINIDE_ROW = 10
/** f 区行的起始列 */
const F_BLOCK_FIRST_COL = 3
/** 总列数 */
export const GRID_COLS = 18

/**
 * 求元素所在周期。
 *
 * @param z 原子序数 1~118
 * @returns 周期 1~7；序号越界返回 0
 * @example
 * periodOf(26) // 4
 */
export function periodOf(z: number): number {
  if (!Number.isInteger(z) || z < 1 || z > 118) return 0
  const bounds = [2, 10, 18, 36, 54, 86, 118]
  return bounds.findIndex((b) => z <= b) + 1
}

/**
 * 求元素在网格里的位置（镧系、锕系放到主表下方两行）。
 *
 * @param z 原子序数 1~118
 * @returns 行列位置；序号越界返回 null
 * @example
 * gridPos(26) // { row: 4, col: 8 }
 */
export function gridPos(z: number): GridPos | null {
  const period = periodOf(z)
  if (period === 0) return null
  if (z >= LANTHANIDE_START && z <= LANTHANIDE_END) return { row: LANTHANIDE_ROW, col: z - LANTHANIDE_START + F_BLOCK_FIRST_COL }
  if (z >= ACTINIDE_START && z <= ACTINIDE_END) return { row: ACTINIDE_ROW, col: z - ACTINIDE_START + F_BLOCK_FIRST_COL }
  if (z === 1) return { row: 1, col: 1 }
  if (z === 2) return { row: 1, col: GRID_COLS }
  const first = [0, 0, 2, 10, 18, 36, 54, 86][period] // 本周期前一个周期末尾的序号
  const offset = z - first // 本周期内第几个，从 1 开始
  if (period <= 3) return { row: period, col: offset <= 2 ? offset : offset + 10 }
  // 第 6、7 周期：前两个是 s 区，之后 f 区 14 个（La/Ac 或 Lu/Lr 算进 d 区）单列到下方，d 区从第 4 列接着排
  if (period >= 6) return { row: period, col: offset > 2 ? offset - 14 : offset }
  return { row: period, col: offset }
}

/**
 * 求元素所在族号（f 区镧系、锕系没有族号）。
 *
 * @param z 原子序数 1~118
 * @returns 族号 1~18；f 区或越界返回 null
 * @example
 * groupOf(17) // 17
 */
export function groupOf(z: number): number | null {
  const p = gridPos(z)
  if (!p || p.row > 7) return null
  return p.col
}

/** 子壳层容量：s=2 p=6 d=10 f=14 */
const SUBSHELL_CAP: Record<string, number> = { s: 2, p: 6, d: 10, f: 14 }
/** 子壳层的角量子数，用来排序 */
const SUBSHELL_L: Record<string, number> = { s: 0, p: 1, d: 2, f: 3 }
/** 按 Madelung 规则的填充顺序 */
const FILL_ORDER = [
  '1s', '2s', '2p', '3s', '3p', '4s', '3d', '4p', '5s', '4d', '5p', '6s', '4f', '5d', '6p', '7s', '5f', '6d', '7p',
]
/** 稀有气体序号与符号，用来做 [Ar] 这样的简写 */
const NOBLE_CORES: Array<[number, string]> = [[86, 'Rn'], [54, 'Xe'], [36, 'Kr'], [18, 'Ar'], [10, 'Ne'], [2, 'He']]
/** 偏离 Madelung 规则的基态，key 为原子序数，value 为要改写的子壳层电子数 */
const CONFIG_EXCEPTIONS: Record<number, Record<string, number>> = {
  24: { '3d': 5, '4s': 1 },
  29: { '3d': 10, '4s': 1 },
  41: { '4d': 4, '5s': 1 },
  42: { '4d': 5, '5s': 1 },
  44: { '4d': 7, '5s': 1 },
  45: { '4d': 8, '5s': 1 },
  46: { '4d': 10, '5s': 0 },
  47: { '4d': 10, '5s': 1 },
  57: { '4f': 0, '5d': 1 },
  58: { '4f': 1, '5d': 1 },
  64: { '4f': 7, '5d': 1 },
  78: { '5d': 9, '6s': 1 },
  79: { '5d': 10, '6s': 1 },
  89: { '5f': 0, '6d': 1 },
  90: { '5f': 0, '6d': 2 },
  91: { '5f': 2, '6d': 1 },
  92: { '5f': 3, '6d': 1 },
  93: { '5f': 4, '6d': 1 },
  96: { '5f': 7, '6d': 1 },
  103: { '6d': 0, '7p': 1 },
}

/**
 * 求基态电子排布（带稀有气体简写），例外元素按实验结果修正。
 * 104 号以后为理论预测值。
 *
 * @param z 原子序数 1~118
 * @returns 如 "[Ar]3d6 4s2"；越界返回空串
 * @example
 * electronConfig(26) // "[Ar]3d6 4s2"
 * electronConfig(1)  // "1s1"
 */
export function electronConfig(z: number): string {
  if (!Number.isInteger(z) || z < 1 || z > 118) return ''
  const occ: Record<string, number> = {}
  let left = z
  for (const sub of FILL_ORDER) {
    if (left <= 0) break
    const n = Math.min(left, SUBSHELL_CAP[sub[1]])
    occ[sub] = n
    left -= n
  }
  const fix = CONFIG_EXCEPTIONS[z]
  if (fix) for (const k of Object.keys(fix)) occ[k] = fix[k]
  // 找能整体替换的最大稀有气体核（要求核内子壳层在 occ 里都是满的）
  const coreOcc = (coreZ: number): Record<string, number> => {
    const c: Record<string, number> = {}
    let r = coreZ
    for (const sub of FILL_ORDER) {
      if (r <= 0) break
      const n = Math.min(r, SUBSHELL_CAP[sub[1]])
      c[sub] = n
      r -= n
    }
    return c
  }
  let prefix = ''
  let rest = { ...occ }
  for (const [coreZ, sym] of NOBLE_CORES) {
    if (coreZ >= z) continue
    const core = coreOcc(coreZ)
    if (Object.keys(core).every((k) => (occ[k] ?? 0) === core[k])) {
      prefix = `[${sym}]`
      rest = {}
      for (const k of Object.keys(occ)) if (!(k in core)) rest[k] = occ[k]
      break
    }
  }
  const parts = Object.keys(rest)
    .filter((k) => rest[k] > 0)
    .sort((a, b) => Number(a[0]) - Number(b[0]) || SUBSHELL_L[a[1]] - SUBSHELL_L[b[1]])
    .map((k) => `${k}${rest[k]}`)
  return prefix + parts.join(' ')
}

/**
 * 搜索元素：支持序号、符号（不分大小写）、中文名、英文名（包含匹配）。
 *
 * @param query 关键字，空串返回全部
 * @returns 命中的元素，按原子序数升序
 * @example
 * searchElements('铁')[0].symbol // "Fe"
 * searchElements('26')[0].symbol // "Fe"
 */
export function searchElements(query: string): Element[] {
  const q = query.trim().toLowerCase()
  if (!q) return ELEMENTS.slice()
  if (/^\d+$/.test(q)) return ELEMENTS.filter((e) => e.z === Number(q))
  return ELEMENTS.filter(
    (e) => e.symbol.toLowerCase() === q || e.cn.includes(q) || e.en.toLowerCase().includes(q),
  )
}

/**
 * 格式化相对原子质量；没有标准原子量的加方括号表示质量数。
 *
 * @param e 元素
 * @returns 如 "55.845"、"[98]"
 * @example
 * formatMass(ELEMENTS[0]) // "1.008"
 */
export function formatMass(e: Element): string {
  return e.massIsNumber ? `[${e.mass}]` : String(e.mass)
}

/**
 * 判断元素是否带放射性（Tc、Pm 及 84 号以后）。
 *
 * @param z 原子序数
 * @returns 是否放射性
 * @example
 * isRadioactive(92) // true
 */
export function isRadioactive(z: number): boolean {
  return z === 43 || z === 61 || z >= 84
}
