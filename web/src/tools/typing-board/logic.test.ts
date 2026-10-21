import { describe, expect, it } from 'vitest'
import { createToolStorage, type StorageLike } from '@/shared/toolStorage'
import {
  blinkPeriod,
  clampNum,
  cleanText,
  DEFAULT_TEXT,
  invertColor,
  loadRecent,
  overflows,
  pushRecent,
  RECENT_KEY,
  RECENT_MAX,
  saveRecent,
  scrollDuration,
  STAGE_PAD,
  TEXT_MAX,
  isHexColor,
  inRange,
} from './logic'

/** 内存存储后端 */
function memBackend(init: Record<string, string> = {}): StorageLike {
  const m = new Map<string, string>(Object.entries(init))
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size
    },
  }
}

describe('overflows', () => {
  it('超过屏宽减两侧留白才算超出', () => {
    expect(overflows(360 - STAGE_PAD * 2, 360)).toBe(false)
    expect(overflows(360 - STAGE_PAD * 2 + 1, 360)).toBe(true)
    expect(overflows(1000, 360)).toBe(true)
  })
  it('宽度无效按没超出', () => {
    expect(overflows(0, 360)).toBe(false)
    expect(overflows(100, 0)).toBe(false)
    expect(overflows(NaN, 360)).toBe(false)
  })
})

describe('scrollDuration', () => {
  it('文字加屏宽除以速度', () => {
    expect(scrollDuration(400, 600, 200)).toBe(5)
  })
  it('非法入参返回 0', () => {
    expect(scrollDuration(-1, 600, 200)).toBe(0)
    expect(scrollDuration(400, 0, 200)).toBe(0)
    expect(scrollDuration(400, 600, 0)).toBe(0)
  })
})

describe('clampNum / blinkPeriod', () => {
  it('夹取与非法值', () => {
    expect(clampNum(5, 0, 3)).toBe(3)
    expect(clampNum(-1, 0, 3)).toBe(0)
    expect(clampNum(NaN, 1, 3)).toBe(1)
  })
  it('频率夹到 0.5~2 再取倒数', () => {
    expect(blinkPeriod(2)).toBe(0.5)
    expect(blinkPeriod(10)).toBe(0.5)
    expect(blinkPeriod(0.1)).toBe(2)
  })
})

describe('cleanText', () => {
  it('空白合并成一个空格并去首尾', () => {
    expect(cleanText('  hi\n there  ')).toBe('hi there')
  })
  it('空文案用默认文案，超长截断', () => {
    expect(cleanText('  \n ')).toBe(DEFAULT_TEXT)
    expect(Array.from(cleanText('字'.repeat(TEXT_MAX + 50))).length).toBe(TEXT_MAX)
  })
})

describe('invertColor', () => {
  it('取反与非法格式', () => {
    expect(invertColor('#000000')).toBe('#ffffff')
    expect(invertColor('#ffeb3b')).toBe('#0014c4')
    expect(invertColor('red')).toBe('red')
  })
})

describe('最近文案', () => {
  it('置顶去重并限制条数', () => {
    expect(pushRecent(['a', 'b'], 'b')).toEqual(['b', 'a'])
    expect(pushRecent(['a'], '  ')).toEqual(['a'])
    const many = Array.from({ length: RECENT_MAX }, (_, i) => `t${i}`)
    expect(pushRecent(many, 'new')).toHaveLength(RECENT_MAX)
  })
  it('存取往返，损坏或不可用时静默', () => {
    const s = createToolStorage('typing-board', memBackend())
    saveRecent(s, ['x', 'y'])
    expect(loadRecent(s)).toEqual(['x', 'y'])
    expect(loadRecent(createToolStorage('typing-board', memBackend({ typing_board_x: '1', 'typing-board_recent': '{bad' })))).toEqual([])
    expect(loadRecent(createToolStorage('typing-board', null))).toEqual([])
    expect(() => saveRecent(createToolStorage('typing-board', null), ['x'])).not.toThrow()
  })
  it('旧键迁移', () => {
    const b = memBackend({ [RECENT_KEY]: '["a","b"]' })
    expect(loadRecent(createToolStorage('typing-board', b))).toEqual(['a', 'b'])
    expect(b.getItem(RECENT_KEY)).toBeNull()
  })
})

describe('持久化校验', () => {
  it('isHexColor / inRange', () => {
    expect(isHexColor('#a1B2c3')).toBe(true)
    expect(isHexColor('red')).toBe(false)
    expect(isHexColor(null)).toBe(false)
    expect(inRange(5, 1, 9)).toBe(true)
    expect(inRange(10, 1, 9)).toBe(false)
    expect(inRange('5', 1, 9)).toBe(false)
  })
})
