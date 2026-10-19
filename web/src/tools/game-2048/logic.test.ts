import { afterEach, describe, expect, it, vi } from 'vitest'
import { addRandomTile, BEST_KEY, canMove, emptyBoard, hasWon, loadBest, move, newGame, saveBest, slideLine, step, swipeDir } from './logic'

/** 把 4x4 二维写法转成一维 */
const b = (rows: number[][]) => rows.flat()

afterEach(() => vi.unstubAllGlobals())

describe('slideLine', () => {
  it('基本合并', () => {
    expect(slideLine([2, 2, 0, 0])).toEqual({ line: [4, 0, 0, 0], gained: 4 })
  })
  it('四连只两两合并', () => {
    expect(slideLine([2, 2, 2, 2])).toEqual({ line: [4, 4, 0, 0], gained: 8 })
  })
  it('三连从靠前的开始合', () => {
    expect(slideLine([2, 2, 2, 0])).toEqual({ line: [4, 2, 0, 0], gained: 4 })
  })
  it('合并结果不再二次合并', () => {
    expect(slideLine([4, 2, 2, 0])).toEqual({ line: [4, 4, 0, 0], gained: 4 })
  })
  it('空隙压紧', () => {
    expect(slideLine([0, 2, 0, 4])).toEqual({ line: [2, 4, 0, 0], gained: 0 })
  })
  it('无变化', () => {
    expect(slideLine([2, 4, 8, 16])).toEqual({ line: [2, 4, 8, 16], gained: 0 })
  })
})

describe('move', () => {
  const start = b([
    [2, 0, 2, 4],
    [0, 0, 0, 0],
    [4, 4, 0, 0],
    [0, 2, 0, 2],
  ])
  it('向左', () => {
    const r = move(start, 'left')
    expect(r.board).toEqual(b([[4, 4, 0, 0], [0, 0, 0, 0], [8, 0, 0, 0], [4, 0, 0, 0]]))
    expect(r.gained).toBe(4 + 8 + 4)
    expect(r.moved).toBe(true)
  })
  it('向右', () => {
    expect(move(start, 'right').board).toEqual(b([[0, 0, 4, 4], [0, 0, 0, 0], [0, 0, 0, 8], [0, 0, 0, 4]]))
  })
  it('向上', () => {
    expect(move(start, 'up').board).toEqual(b([[2, 4, 2, 4], [4, 2, 0, 2], [0, 0, 0, 0], [0, 0, 0, 0]]))
  })
  it('向下', () => {
    expect(move(start, 'down').board).toEqual(b([[0, 0, 0, 0], [0, 0, 0, 0], [2, 4, 0, 4], [4, 2, 2, 2]]))
  })
  it('没变化时 moved 为 false 且不得分', () => {
    const full = b([[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]])
    expect(move(full, 'left')).toEqual({ board: full, gained: 0, moved: false })
  })
  it('不修改入参', () => {
    const copy = start.slice()
    move(start, 'left')
    expect(start).toEqual(copy)
  })
})

describe('addRandomTile / newGame / step', () => {
  it('在指定空格放 2 或 4', () => {
    const first = [0, 0.5]
    expect(addRandomTile(emptyBoard(), () => first.shift() ?? 0)[0]).toBe(2)
    // 第一个 rand 选位置 0.999 -> 最后一个空格，第二个 rand 0.05 -> 4
    const seq = [0.999, 0.05]
    const r = addRandomTile(emptyBoard(), () => seq.shift() ?? 0)
    expect(r[15]).toBe(4)
  })
  it('满盘不变', () => {
    const full = Array.from({ length: 16 }, () => 2)
    expect(addRandomTile(full)).toBe(full)
  })
  it('新局恰好两个方块', () => {
    expect(newGame().filter((v) => v > 0)).toHaveLength(2)
  })
  it('有效移动后多出一个方块，无效移动不出块', () => {
    const base = b([[2, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]])
    expect(step(base, 'right', () => 0).board.filter((v) => v > 0)).toHaveLength(2)
    expect(step(base, 'left', () => 0).board).toEqual(base)
  })
})

describe('canMove / hasWon', () => {
  it('有空格可走', () => {
    expect(canMove(newGame())).toBe(true)
  })
  it('满盘无相邻相同则结束', () => {
    expect(canMove(b([[2, 4, 2, 4], [4, 2, 4, 2], [2, 4, 2, 4], [4, 2, 4, 2]]))).toBe(false)
  })
  it('满盘但横向相邻相同还能走', () => {
    expect(canMove(b([[2, 2, 4, 8], [4, 8, 2, 4], [2, 4, 8, 2], [8, 2, 4, 8]]))).toBe(true)
  })
  it('满盘但纵向相邻相同还能走', () => {
    expect(canMove(b([[2, 4, 8, 16], [2, 8, 16, 4], [4, 16, 4, 2], [8, 2, 16, 8]]))).toBe(true)
  })
  it('hasWon', () => {
    expect(hasWon(b([[2048, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]]))).toBe(true)
    expect(hasWon(emptyBoard())).toBe(false)
  })
})

describe('swipeDir', () => {
  it('四个方向与阈值', () => {
    expect(swipeDir(50, 10)).toBe('right')
    expect(swipeDir(-50, 10)).toBe('left')
    expect(swipeDir(5, 60)).toBe('down')
    expect(swipeDir(5, -60)).toBe('up')
    expect(swipeDir(10, 10)).toBeNull()
  })
})

describe('最高分存储', () => {
  it('读写往返', () => {
    const m = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => m.set(k, v) })
    expect(loadBest()).toBe(0)
    expect(saveBest(1234)).toBe(true)
    expect(m.get(BEST_KEY)).toBe('1234')
    expect(loadBest()).toBe(1234)
  })
  it('存储不可用时静默', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(loadBest()).toBe(0)
    expect(saveBest(5)).toBe(false)
  })
})
