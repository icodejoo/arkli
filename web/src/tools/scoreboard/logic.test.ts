import { afterEach, describe, expect, it, vi } from 'vitest'
import { createToolStorage } from '../../shared/toolStorage'
import {
  addScore, createState, defaultName, loadState, MAX_HISTORY, MAX_PLAYERS, MAX_STEP, normalizeStep, rankPlayers,
  renamePlayer, resetScores, sanitizeState, saveState, setPlayerCount, STATE_KEY, STORAGE_KEY, TOOL_NS, undo,
} from './logic'

describe('createState / defaultName', () => {
  it('默认 2 人，人数被限制在 2~8', () => {
    expect(createState().players.length).toBe(2)
    expect(createState(1).players.length).toBe(2)
    expect(createState(99).players.length).toBe(MAX_PLAYERS)
    expect(createState(NaN).players.length).toBe(2)
    expect(defaultName(2)).toBe('玩家 3')
  })
})

describe('normalizeStep', () => {
  it('取整、限范围、非法回默认', () => {
    expect(normalizeStep('5')).toBe(5)
    expect(normalizeStep(2.9)).toBe(2)
    expect(normalizeStep(0)).toBe(1)
    expect(normalizeStep(-3)).toBe(1)
    expect(normalizeStep('abc')).toBe(1)
    expect(normalizeStep(1e9)).toBe(MAX_STEP)
  })
})

describe('addScore / undo', () => {
  it('加减分不改原对象，并写入历史', () => {
    const s = createState(2)
    const n = addScore(s, 1, 5)
    expect(s.players[1].score).toBe(0)
    expect(n.players[1].score).toBe(5)
    expect(addScore(n, 1, -8).players[1].score).toBe(-3)
    expect(n.history).toEqual([{ index: 1, delta: 5 }])
  })
  it('越界、非整数下标、delta 为 0 原样返回', () => {
    const s = createState(2)
    expect(addScore(s, 2, 1)).toBe(s)
    expect(addScore(s, -1, 1)).toBe(s)
    expect(addScore(s, 0.5, 1)).toBe(s)
    expect(addScore(s, 0, 0)).toBe(s)
  })
  it('历史有上限', () => {
    let s = createState(2)
    for (let i = 0; i < MAX_HISTORY + 20; i++) s = addScore(s, 0, 1)
    expect(s.history.length).toBe(MAX_HISTORY)
    expect(s.players[0].score).toBe(MAX_HISTORY + 20)
  })
  it('撤销逐步还原，空历史原样返回', () => {
    const s0 = createState(2)
    expect(undo(s0)).toBe(s0)
    const s2 = addScore(addScore(s0, 0, 3), 1, 2)
    const u1 = undo(s2)
    expect(u1.players.map((p) => p.score)).toEqual([3, 0])
    expect(undo(u1).players.map((p) => p.score)).toEqual([0, 0])
  })
})

describe('resetScores', () => {
  it('清零分数与历史，保留名字与步长', () => {
    let s = renamePlayer(createState(3), 0, '阿明')
    s = { ...addScore(s, 0, 9), step: 5 }
    const r = resetScores(s)
    expect(r.players.map((p) => p.score)).toEqual([0, 0, 0])
    expect(r.players[0].name).toBe('阿明')
    expect(r.history).toEqual([])
    expect(r.step).toBe(5)
  })
})

describe('setPlayerCount', () => {
  it('加人补默认名，减人砍末尾并清掉相关历史', () => {
    let s = addScore(addScore(createState(2), 0, 1), 1, 2)
    s = setPlayerCount(s, 4)
    expect(s.players.map((p) => p.name)).toEqual(['玩家 1', '玩家 2', '玩家 3', '玩家 4'])
    s = addScore(s, 3, 7)
    s = setPlayerCount(s, 2)
    expect(s.players.length).toBe(2)
    expect(s.history.every((m) => m.index < 2)).toBe(true)
  })
  it('人数不变原样返回，越界被限制', () => {
    const s = createState(3)
    expect(setPlayerCount(s, 3)).toBe(s)
    expect(setPlayerCount(s, 100).players.length).toBe(MAX_PLAYERS)
    expect(setPlayerCount(s, 0).players.length).toBe(2)
  })
})

describe('renamePlayer', () => {
  it('去空白、截断、空名回默认、越界无效', () => {
    const s = createState(2)
    expect(renamePlayer(s, 0, '  小红 ').players[0].name).toBe('小红')
    expect(renamePlayer(s, 1, '   ').players[1].name).toBe('玩家 2')
    expect(Array.from(renamePlayer(s, 0, 'x'.repeat(30)).players[0].name).length).toBe(12)
    expect(renamePlayer(s, 5, 'a')).toBe(s)
  })
})

describe('rankPlayers', () => {
  it('高分在前，并列同名次', () => {
    const r = rankPlayers([
      { name: 'a', score: 5 },
      { name: 'b', score: 9 },
      { name: 'c', score: 5 },
      { name: 'd', score: 1 },
    ])
    expect(r.map((x) => x.index)).toEqual([1, 0, 2, 3])
    expect(r.map((x) => x.rank)).toEqual([1, 2, 2, 4])
    expect(r.map((x) => x.leading)).toEqual([true, false, false, false])
  })
  it('全员同分不标领先', () => {
    const r = rankPlayers([
      { name: 'a', score: 0 },
      { name: 'b', score: 0 },
    ])
    expect(r.every((x) => !x.leading && x.rank === 1)).toBe(true)
  })
  it('并列第一都高亮', () => {
    const r = rankPlayers([
      { name: 'a', score: 3 },
      { name: 'b', score: 3 },
      { name: 'c', score: 1 },
    ])
    expect(r.filter((x) => x.leading).length).toBe(2)
  })
})

describe('sanitizeState', () => {
  it('非法整体回默认', () => {
    expect(sanitizeState(null)).toEqual(createState())
    expect(sanitizeState('x')).toEqual(createState())
    expect(sanitizeState({ players: [] })).toEqual(createState())
    expect(sanitizeState({ players: new Array(9).fill({}) })).toEqual(createState())
  })
  it('字段级修复', () => {
    const s = sanitizeState({
      players: [{ name: ' 甲 ', score: 3.7 }, { name: 5, score: 'x' }, null],
      step: -1,
      history: [{ index: 0, delta: 2 }, { index: 9, delta: 1 }, { index: 0, delta: NaN }, null],
    })
    expect(s.players).toEqual([
      { name: '甲', score: 3 },
      { name: '玩家 2', score: 0 },
      { name: '玩家 3', score: 0 },
    ])
    expect(s.step).toBe(1)
    expect(s.history).toEqual([{ index: 0, delta: 2 }])
  })
  it('合法数据原样通过', () => {
    const s = addScore(createState(3), 2, 4)
    expect(sanitizeState(JSON.parse(JSON.stringify(s)))).toEqual(s)
  })
})

/** 内存版 localStorage，可选让读写抛错 */
function fakeStorage(throws = false) {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => {
      if (throws) throw new Error('denied')
      return m.has(k) ? (m.get(k) as string) : null
    },
    setItem: (k: string, v: string) => {
      if (throws) throw new Error('quota')
      m.set(k, v)
    },
    removeItem: (k: string) => void m.delete(k),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    },
  }
}

describe('loadState / saveState', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('存取往返', () => {
    const store = createToolStorage(TOOL_NS, fakeStorage())
    const s = addScore(createState(3), 1, 6)
    expect(saveState(s, store)).toBe(true)
    expect(loadState(store)).toEqual(s)
  })
  it('无数据或坏数据返回默认', () => {
    const st = fakeStorage()
    const store = createToolStorage(TOOL_NS, st)
    expect(loadState(store)).toEqual(createState())
    st.setItem(`${TOOL_NS}_${STATE_KEY}`, '{bad')
    expect(loadState(store)).toEqual(createState())
  })
  it('迁移旧键', () => {
    const st = fakeStorage()
    const s = addScore(createState(3), 1, 6)
    st.setItem(STORAGE_KEY, JSON.stringify(s))
    expect(loadState(createToolStorage(TOOL_NS, st))).toEqual(s)
    expect(st.getItem(STORAGE_KEY)).toBeNull()
  })
  it('存储抛错时不崩', () => {
    const store = createToolStorage(TOOL_NS, fakeStorage(true))
    expect(loadState(store)).toEqual(createState())
    expect(saveState(createState(), store)).toBe(false)
  })
  it('localStorage 不存在时不崩', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(loadState()).toEqual(createState())
    expect(saveState(createState())).toBe(false)
  })
})
