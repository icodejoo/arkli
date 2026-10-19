// 扫雷：布雷、翻开（连锁展开）、插旗与胜负判定（纯函数，状态不可变）

/** 随机函数：返回 [0,1) */
export type Rand = () => number

/** 难度配置 */
export interface Level {
  /** 标识 */
  id: 'easy' | 'medium' | 'hard'
  /** 名称 */
  name: string
  /** 行数 */
  rows: number
  /** 列数 */
  cols: number
  /** 雷数 */
  mines: number
}

/** 三档难度：初级、中级、高级（竖屏友好，高级为 30 行 16 列） */
export const LEVELS: readonly Level[] = [
  { id: 'easy', name: '初级', rows: 9, cols: 9, mines: 10 },
  { id: 'medium', name: '中级', rows: 16, cols: 16, mines: 40 },
  { id: 'hard', name: '高级', rows: 30, cols: 16, mines: 99 },
]

/** 格子状态 */
export type CellState = 'hidden' | 'open' | 'flag'
/** 对局状态：未开局 / 进行中 / 胜 / 负 */
export type Status = 'ready' | 'playing' | 'won' | 'lost'

/** 单个格子 */
export interface Cell {
  /** 是否有雷 */
  mine: boolean
  /** 周围雷数 */
  adj: number
  /** 状态 */
  state: CellState
}

/** 一局游戏 */
export interface Game {
  /** 行数 */
  rows: number
  /** 列数 */
  cols: number
  /** 雷数 */
  mines: number
  /** 格子，行优先 */
  cells: readonly Cell[]
  /** 状态 */
  status: Status
  /** 踩中的雷下标，未踩中为 -1 */
  boom: number
}

/**
 * 新建一局（尚未布雷，首次翻开时才布）。
 *
 * @param level 难度
 * @returns 新对局
 * @example createGame(LEVELS[0])
 */
export function createGame(level: Pick<Level, 'rows' | 'cols' | 'mines'>): Game {
  const cells = Array.from({ length: level.rows * level.cols }, (): Cell => ({ mine: false, adj: 0, state: 'hidden' }))
  return { rows: level.rows, cols: level.cols, mines: level.mines, cells, status: 'ready', boom: -1 }
}

/**
 * 某格的相邻格下标（最多 8 个）。
 *
 * @param g 对局（取行列数）
 * @param idx 格子下标
 * @returns 相邻下标列表
 * @example neighbors(createGame(LEVELS[0]), 0) // 3 个
 */
export function neighbors(g: Pick<Game, 'rows' | 'cols'>, idx: number): number[] {
  const r = Math.floor(idx / g.cols)
  const c = idx % g.cols
  const out: number[] = []
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue
      const nr = r + dr
      const nc = c + dc
      if (nr >= 0 && nr < g.rows && nc >= 0 && nc < g.cols) out.push(nr * g.cols + nc)
    }
  }
  return out
}

/**
 * 布雷：避开首次点击的格子及其周围（雷数太多放不下时只避开点击格）。
 *
 * @param g 未布雷的对局
 * @param first 首次点击的下标
 * @param rand 随机函数
 * @returns 布好雷、算好周围雷数的格子
 */
function placeMines(g: Game, first: number, rand: Rand): Cell[] {
  const total = g.cells.length
  const banned = new Set([first, ...neighbors(g, first)])
  let pool = Array.from({ length: total }, (_, i) => i).filter((i) => !banned.has(i))
  if (pool.length < g.mines) pool = Array.from({ length: total }, (_, i) => i).filter((i) => i !== first)
  // 部分洗牌取前 mines 个
  for (let i = 0; i < g.mines; i++) {
    const j = i + Math.min(pool.length - i - 1, Math.floor(rand() * (pool.length - i)))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  const cells = g.cells.map((c): Cell => ({ ...c }))
  for (let i = 0; i < g.mines; i++) cells[pool[i]].mine = true
  cells.forEach((c, i) => (c.adj = neighbors(g, i).filter((n) => cells[n].mine).length))
  return cells
}

/**
 * 翻开一格：首次点击才布雷；空白格连锁展开；踩雷则输；翻完所有安全格则赢。
 *
 * @param g 当前对局
 * @param idx 要翻开的下标
 * @param rand 随机函数（可注入）
 * @returns 新对局；已结束、已翻开或已插旗的格子原样返回
 * @example reveal(createGame(LEVELS[0]), 40)
 */
export function reveal(g: Game, idx: number, rand: Rand = Math.random): Game {
  if (g.status === 'won' || g.status === 'lost') return g
  if (g.cells[idx].state !== 'hidden') return g
  const cells = g.status === 'ready' ? placeMines(g, idx, rand) : g.cells.map((c): Cell => ({ ...c }))
  const next: Game = { ...g, cells, status: 'playing' }

  if (cells[idx].mine) {
    cells.forEach((c) => {
      if (c.mine && c.state !== 'flag') c.state = 'open'
    })
    return { ...next, status: 'lost', boom: idx }
  }

  // 广度优先展开：adj 为 0 的格子继续展开周围
  const queue = [idx]
  while (queue.length) {
    const cur = queue.pop() as number
    const cell = cells[cur]
    if (cell.state !== 'hidden') continue
    cell.state = 'open'
    if (cell.adj === 0) queue.push(...neighbors(g, cur))
  }

  if (cells.filter((c) => c.state === 'open').length === cells.length - g.mines) {
    cells.forEach((c) => {
      if (c.mine) c.state = 'flag'
    })
    return { ...next, status: 'won' }
  }
  return next
}

/**
 * 切换插旗（只作用于未翻开的格子）。
 *
 * @param g 当前对局
 * @param idx 下标
 * @returns 新对局；不可操作时原样返回
 * @example toggleFlag(game, 3)
 */
export function toggleFlag(g: Game, idx: number): Game {
  if (g.status === 'won' || g.status === 'lost') return g
  const cur = g.cells[idx].state
  if (cur === 'open') return g
  const cells = g.cells.map((c, i): Cell => (i === idx ? { ...c, state: cur === 'flag' ? 'hidden' : 'flag' } : c))
  return { ...g, cells }
}

/**
 * 剩余雷数（雷数减旗数，可为负）。
 *
 * @param g 对局
 * @returns 剩余雷数
 */
export function minesLeft(g: Game): number {
  return g.mines - g.cells.filter((c) => c.state === 'flag').length
}

/**
 * 计时秒数格式化为三位（最大 999）。
 *
 * @param sec 秒数
 * @returns 如 "007"
 * @example formatTime(7) // '007'
 */
export function formatTime(sec: number): string {
  return String(Math.min(999, Math.max(0, Math.floor(sec)))).padStart(3, '0')
}
