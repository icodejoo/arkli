// 2048：棋盘移动合并、随机出块、结束判断与最高分存储（纯函数，与 Vue 解耦）
import { createToolStorage, type ToolStorage } from '@/shared/toolStorage'

/** 棋盘边长 */
export const SIZE = 4
/** 出现 4 的概率 */
export const FOUR_RATE = 0.1
/** 胜利目标方块 */
export const WIN_TILE = 2048
/** 持久缓存命名空间 */
export const STORE_NS = 'game-2048'
/** 最高分缓存键（命名空间内） */
export const BEST_KEY = 'best'
/** 旧版最高分 localStorage 键，仅用于迁移 */
export const LEGACY_BEST_KEY = 'arkli:game-2048:best'

/** 棋盘：长度 SIZE*SIZE 的行优先数组，0 表示空格 */
export type Board = readonly number[]
/** 滑动方向 */
export type Dir = 'left' | 'right' | 'up' | 'down'
/** 随机函数：返回 [0,1) */
export type Rand = () => number

/** 一次移动的结果 */
export interface MoveResult {
  /** 移动后的棋盘 */
  board: Board
  /** 本次合并得分 */
  gained: number
  /** 棋盘是否发生变化 */
  moved: boolean
}

/**
 * 把一行向左压紧并合并（每个方块一次移动只合并一次）。
 *
 * @param line 一行数值
 * @returns 新行与得分
 * @example slideLine([2, 2, 2, 2]) // { line: [4, 4, 0, 0], gained: 8 }
 */
export function slideLine(line: readonly number[]): { line: number[]; gained: number } {
  const tiles = line.filter((v) => v > 0)
  const out: number[] = []
  let gained = 0
  for (let i = 0; i < tiles.length; i++) {
    if (i + 1 < tiles.length && tiles[i] === tiles[i + 1]) {
      const v = tiles[i] * 2
      out.push(v)
      gained += v
      i++
    } else {
      out.push(tiles[i])
    }
  }
  while (out.length < line.length) out.push(0)
  return { line: out, gained }
}

/**
 * 某方向上第 k 条线的棋盘下标（顺序为“朝移动方向的末端”在后）。
 *
 * @param dir 方向
 * @param k 第几条线
 * @returns 该线 SIZE 个下标，第 0 个是移动目标端
 */
function lineIndexes(dir: Dir, k: number): number[] {
  const idx = Array.from({ length: SIZE }, (_, j) => j)
  switch (dir) {
    case 'left':
      return idx.map((j) => k * SIZE + j)
    case 'right':
      return idx.map((j) => k * SIZE + (SIZE - 1 - j))
    case 'up':
      return idx.map((j) => j * SIZE + k)
    default:
      return idx.map((j) => (SIZE - 1 - j) * SIZE + k)
  }
}

/**
 * 按方向移动并合并整个棋盘（不出新块）。
 *
 * @param board 当前棋盘
 * @param dir 方向
 * @returns 新棋盘、得分与是否变化
 * @example move([2,2,0,0, ...], 'left').board[0] // 4
 */
export function move(board: Board, dir: Dir): MoveResult {
  const next = board.slice()
  let gained = 0
  for (let k = 0; k < SIZE; k++) {
    const idx = lineIndexes(dir, k)
    const r = slideLine(idx.map((i) => board[i]))
    gained += r.gained
    idx.forEach((boardIdx, j) => (next[boardIdx] = r.line[j]))
  }
  return { board: next, gained, moved: next.some((v, i) => v !== board[i]) }
}

/**
 * 在随机空格里放一个 2（或小概率 4）；没空格则原样返回。
 *
 * @param board 当前棋盘
 * @param rand 随机函数（可注入）
 * @returns 新棋盘
 * @example addRandomTile(emptyBoard(), () => 0)
 */
export function addRandomTile(board: Board, rand: Rand = Math.random): Board {
  const empty = board.flatMap((v, i) => (v === 0 ? [i] : []))
  if (empty.length === 0) return board
  const pos = empty[Math.min(empty.length - 1, Math.floor(rand() * empty.length))]
  const next = board.slice()
  next[pos] = rand() < FOUR_RATE ? 4 : 2
  return next
}

/**
 * 空棋盘。
 *
 * @returns 全 0 棋盘
 */
export function emptyBoard(): Board {
  return Array.from({ length: SIZE * SIZE }, () => 0)
}

/**
 * 新局：放两个初始方块。
 *
 * @param rand 随机函数
 * @returns 新棋盘
 * @example newGame()
 */
export function newGame(rand: Rand = Math.random): Board {
  return addRandomTile(addRandomTile(emptyBoard(), rand), rand)
}

/**
 * 还能不能走（有空格或相邻可合并）。
 *
 * @param board 棋盘
 * @returns 是否还能动
 * @example canMove(newGame()) // true
 */
export function canMove(board: Board): boolean {
  if (board.includes(0)) return true
  return (['left', 'down'] as Dir[]).some((d) => move(board, d).moved) || (['right', 'up'] as Dir[]).some((d) => move(board, d).moved)
}

/**
 * 是否出现过目标方块。
 *
 * @param board 棋盘
 * @returns 是否达成 2048
 */
export function hasWon(board: Board): boolean {
  return board.some((v) => v >= WIN_TILE)
}

/**
 * 滑动后的完整一步：移动、合并、有变化才出新块。
 *
 * @param board 当前棋盘
 * @param dir 方向
 * @param rand 随机函数
 * @returns 结果（moved 为 false 时棋盘不变、不出块）
 * @example step(newGame(), 'left')
 */
export function step(board: Board, dir: Dir, rand: Rand = Math.random): MoveResult {
  const r = move(board, dir)
  if (!r.moved) return r
  return { ...r, board: addRandomTile(r.board, rand) }
}

/**
 * 读取最高分（会一次性迁移旧键），失败返回 0。
 *
 * @param store 持久缓存，默认 2048 的实例
 * @returns 最高分
 */
export function loadBest(store: ToolStorage = createToolStorage(STORE_NS)): number {
  store.adoptLegacy(LEGACY_BEST_KEY, BEST_KEY)
  const v = Number(store.get<unknown>(BEST_KEY, 0))
  return Number.isFinite(v) && v > 0 ? v : 0
}

/**
 * 保存最高分，失败静默忽略。
 *
 * @param score 分数
 * @param store 持久缓存，默认 2048 的实例
 * @returns 是否写入成功
 */
export function saveBest(score: number, store: ToolStorage = createToolStorage(STORE_NS)): boolean {
  return store.set(BEST_KEY, Math.round(score))
}

/**
 * 根据滑动位移判断方向；位移太小返回 null。
 *
 * @param dx 横向位移
 * @param dy 纵向位移
 * @param min 最小有效位移（像素）
 * @returns 方向或 null
 * @example swipeDir(50, 10) // 'right'
 */
export function swipeDir(dx: number, dy: number, min = 24): Dir | null {
  if (Math.max(Math.abs(dx), Math.abs(dy)) < min) return null
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'right' : 'left'
  return dy > 0 ? 'down' : 'up'
}
