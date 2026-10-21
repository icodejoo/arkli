import { describe, expect, it } from 'vitest'
import { createGame, formatTime, isClockTicking, LEVELS, minesLeft, neighbors, reveal, toggleFlag, type Game } from './logic'

/** 可复现的伪随机 */
function seeded(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 手工布一局：mines 为雷的下标 */
function handmade(rows: number, cols: number, mines: number[]): Game {
  const g = createGame({ rows, cols, mines: mines.length })
  const cells = g.cells.map((c, i) => ({ ...c, mine: mines.includes(i) }))
  cells.forEach((c, i) => (c.adj = neighbors(g, i).filter((n) => cells[n].mine).length))
  return { ...g, cells, status: 'playing' }
}

describe('neighbors', () => {
  const g = createGame(LEVELS[0])
  it('角 3、边 5、中间 8', () => {
    expect(neighbors(g, 0)).toHaveLength(3)
    expect(neighbors(g, 1)).toHaveLength(5)
    expect(neighbors(g, 40)).toHaveLength(8)
  })
  it('右边缘不会绕到下一行', () => {
    expect(neighbors(g, 8).every((n) => n % 9 >= 7)).toBe(true)
  })
})

describe('首次点击', () => {
  it('必不踩雷，且周围也无雷，雷数正确（多种子）', () => {
    for (const lv of LEVELS) {
      for (let s = 1; s <= 30; s++) {
        const first = Math.floor(seeded(s)() * lv.rows * lv.cols)
        const g = reveal(createGame(lv), first, seeded(s * 7))
        expect(g.status === 'lost').toBe(false)
        expect(g.cells.filter((c) => c.mine)).toHaveLength(lv.mines)
        expect(g.cells[first].mine).toBe(false)
        expect(neighbors(g, first).every((n) => !g.cells[n].mine)).toBe(true)
        expect(g.cells[first].state).toBe('open')
      }
    }
  })
  it('雷太密时至少保证点击格安全', () => {
    const g = reveal(createGame({ rows: 3, cols: 3, mines: 8 }), 4, seeded(1))
    expect(g.cells[4].mine).toBe(false)
    expect(g.status).toBe('won')
  })
})

describe('reveal', () => {
  it('空白区连锁展开到数字边界', () => {
    const g = reveal(handmade(4, 4, [15]), 0)
    // 只有雷 15 周围的 10、11、14 是数字，其余空白，全部展开则 15 以外都开
    expect(g.cells.filter((c) => c.state === 'open')).toHaveLength(15)
    expect(g.status).toBe('won')
  })
  it('点到数字格只开自己', () => {
    const g = reveal(handmade(4, 4, [15]), 14)
    expect(g.cells.filter((c) => c.state === 'open')).toHaveLength(1)
    expect(g.status).toBe('playing')
  })
  it('踩雷即输，亮出所有雷并记录位置', () => {
    const g = reveal(handmade(4, 4, [5, 15]), 5)
    expect(g.status).toBe('lost')
    expect(g.boom).toBe(5)
    expect(g.cells[15].state).toBe('open')
  })
  it('插旗的格子不能翻开', () => {
    const base = handmade(4, 4, [15])
    const flagged = toggleFlag(base, 0)
    expect(reveal(flagged, 0)).toBe(flagged)
  })
  it('结束后不再响应', () => {
    const lost = reveal(handmade(4, 4, [5]), 5)
    expect(reveal(lost, 0)).toBe(lost)
    expect(toggleFlag(lost, 0)).toBe(lost)
  })
  it('赢了自动给雷插旗', () => {
    const g = reveal(handmade(4, 4, [15]), 0)
    expect(g.cells[15].state).toBe('flag')
  })
})

describe('toggleFlag / minesLeft', () => {
  it('插旗与取消、剩余雷数', () => {
    let g = handmade(4, 4, [15, 14])
    expect(minesLeft(g)).toBe(2)
    g = toggleFlag(g, 0)
    expect(g.cells[0].state).toBe('flag')
    expect(minesLeft(g)).toBe(1)
    g = toggleFlag(g, 0)
    expect(g.cells[0].state).toBe('hidden')
  })
  it('已翻开的格子不能插旗；旗多于雷时为负', () => {
    const opened = reveal(handmade(4, 4, [15]), 14)
    expect(toggleFlag(opened, 14)).toBe(opened)
    let g = handmade(4, 4, [15])
    g = toggleFlag(toggleFlag(g, 0), 1)
    expect(minesLeft(g)).toBe(-1)
  })
})

describe('formatTime', () => {
  it('补零并封顶 999', () => {
    expect(formatTime(7)).toBe('007')
    expect(formatTime(5000)).toBe('999')
    expect(formatTime(-3)).toBe('000')
  })
})

describe('isClockTicking（浮起回来是否接着走字）', () => {
  it('只有进行中走字', () => {
    expect(isClockTicking('playing')).toBe(true)
    expect(isClockTicking('ready')).toBe(false)
    expect(isClockTicking('won')).toBe(false)
    expect(isClockTicking('lost')).toBe(false)
  })
})
