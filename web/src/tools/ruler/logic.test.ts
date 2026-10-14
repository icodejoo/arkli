import { describe, expect, it } from 'vitest'
import {
  buildTicks,
  CARD_MM,
  clampPos,
  COMPARE_MAX,
  DEFAULT_PX_PER_MM,
  formatLength,
  formatReading,
  formatReadingAlt,
  gapMm,
  loadScale,
  MARK_COLORS,
  mmToPx,
  nextColorIndex,
  pxToMm,
  saveScale,
  scaleFromDpi,
  resolveScale,
  scaleFromCalibration,
  sortMarksByPosition,
  STEP_MM,
  togglePick,
  type KvStorage,
  type RulerMark,
} from './logic'

/** 内存版存储 */
function memStore(init: Record<string, string> = {}): KvStorage {
  const m = { ...init }
  return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => void (m[k] = v) }
}

describe('scaleFromCalibration', () => {
  it('银行卡比例', () => {
    expect(scaleFromCalibration(CARD_MM * 4, CARD_MM)).toBeCloseTo(4)
  })
  it('非法入参返回 null', () => {
    expect(scaleFromCalibration(0, 85.6)).toBeNull()
    expect(scaleFromCalibration(100, 0)).toBeNull()
    expect(scaleFromCalibration(NaN, 10)).toBeNull()
    expect(scaleFromCalibration(5, 100)).toBeNull() // 比例过小
    expect(scaleFromCalibration(5000, 10)).toBeNull() // 比例过大
  })
})

describe('buildTicks', () => {
  it('厘米：每毫米一格，整厘米带数字', () => {
    const t = buildTicks(100, 4, 'cm')
    expect(t[0]).toEqual({ pos: 0, kind: 'major', label: '0' })
    expect(t[5].kind).toBe('half')
    expect(t[1].kind).toBe('minor')
    expect(t[10]).toEqual({ pos: 40, kind: 'major', label: '1' })
    expect(t).toHaveLength(26) // 0..25mm
  })
  it('英寸：1/16 分度，整寸带数字', () => {
    const px = DEFAULT_PX_PER_MM
    const t = buildTicks(px * 25.4 * 2, px, 'inch')
    expect(t.filter((x) => x.kind === 'major').map((x) => x.label)).toEqual(['0', '1', '2'])
    expect(t[8].kind).toBe('half')
    expect(t[4].kind).toBe('half')
    expect(t[1].kind).toBe('minor')
  })
  it('非法长度或比例为空', () => {
    expect(buildTicks(0, 4, 'cm')).toEqual([])
    expect(buildTicks(100, 0, 'cm')).toEqual([])
    expect(buildTicks(100, 100, 'inch')).toEqual([])
  })
})

describe('formatLength', () => {
  it('毫米与英寸', () => {
    expect(formatLength(342.4, 4, 'cm')).toBe('85.6 mm')
    expect(formatLength(4 * 25.4, 4, 'inch')).toBe('1.00 in')
    expect(formatLength(10, 0, 'cm')).toBe('')
  })
})

describe('存取校准比例', () => {
  it('存了能读回', () => {
    const s = memStore()
    expect(saveScale(s, 5.2)).toBe(true)
    expect(loadScale(s)).toBe(5.2)
  })
  it('没存、损坏、越界都得 null', () => {
    expect(loadScale(memStore())).toBeNull()
    expect(loadScale(memStore({ 'arkli:ruler:scale': 'abc' }))).toBeNull()
    expect(loadScale(memStore({ 'arkli:ruler:scale': '99' }))).toBeNull()
    expect(loadScale(undefined)).toBeNull()
  })
  it('存储抛错时不崩', () => {
    const bad: KvStorage = {
      getItem: () => {
        throw new Error('x')
      },
      setItem: () => {
        throw new Error('x')
      },
    }
    expect(loadScale(bad)).toBeNull()
    expect(saveScale(bad, 4)).toBe(false)
    expect(saveScale(memStore(), -1)).toBe(false)
  })
})

describe('游标换算', () => {
  it('像素与毫米互转，往返一致', () => {
    expect(pxToMm(96, DEFAULT_PX_PER_MM)).toBeCloseTo(25.4, 6)
    expect(mmToPx(25.4, DEFAULT_PX_PER_MM)).toBeCloseTo(96, 6)
    expect(mmToPx(pxToMm(123.4, 4.2), 4.2)).toBeCloseTo(123.4, 9)
  })

  it('比例非法时换算为 0，不出 NaN 或 Infinity', () => {
    expect(pxToMm(100, 0)).toBe(0)
    expect(mmToPx(10, NaN)).toBe(0)
  })

  it('游标限幅：负数到 0，超长到尺长，非数字到 0', () => {
    expect(clampPos(-5, 600)).toBe(0)
    expect(clampPos(300, 600)).toBe(300)
    expect(clampPos(900, 600)).toBe(600)
    expect(clampPos(NaN, 600)).toBe(0)
    expect(clampPos(10, -3)).toBe(0)
  })

  it('读数格式：厘米档主显厘米、英寸档主显英寸', () => {
    expect(formatReading(53.7, 'cm')).toBe('5.37 cm')
    expect(formatReading(25.4, 'inch')).toBe('1.00 in')
    expect(formatReading(0, 'cm')).toBe('0.00 cm')
  })

  it('辅助读数：厘米档带毫米与英寸，英寸档带毫米', () => {
    expect(formatReadingAlt(25.4, 'cm')).toBe('25.4 mm · 1.00 in')
    expect(formatReadingAlt(25.4, 'inch')).toBe('25.4 mm')
  })

  it('默认（第一个）颜色是亮绿色', () => {
    expect(MARK_COLORS[0].name).toBe('亮绿')
    expect(MARK_COLORS[0].value).toBe('#1fe05c')
  })

  it('步长与颜色选项合理', () => {
    expect(STEP_MM).toBeGreaterThan(0)
    expect(MARK_COLORS.length).toBe(7)
    expect(new Set(MARK_COLORS.map((c) => c.value)).size).toBe(MARK_COLORS.length)
    for (const c of MARK_COLORS) expect(c.value).toMatch(/^#[0-9a-f]{6}$/)
  })
})

describe('彩虹循环与色相环', () => {
  it('下一个颜色走到末尾回到开头', () => {
    expect(nextColorIndex(0, 7)).toBe(1)
    expect(nextColorIndex(6, 7)).toBe(0)
    expect(nextColorIndex(3, 0)).toBe(0)
  })

  it('连续点七次回到起点，七个颜色各出现一次', () => {
    const seen = new Set<number>()
    let i = 0
    for (let n = 0; n < 7; n++) {
      seen.add(i)
      i = nextColorIndex(i, MARK_COLORS.length)
    }
    expect(seen.size).toBe(7)
    expect(i).toBe(0)
  })

})

describe('标记间距对比', () => {
  const mk = (id: number, mm: number): RulerMark => ({ id, mm, color: '#000000' })

  it('按位置从小到大排，不改动原数组，位置相同保持原顺序', () => {
    const src = [mk(1, 30), mk(2, 10), mk(3, 10), mk(4, 20)]
    expect(sortMarksByPosition(src).map((m) => m.id)).toEqual([2, 3, 4, 1])
    expect(src.map((m) => m.id)).toEqual([1, 2, 3, 4])
  })

  it('空列表排序得空数组', () => {
    expect(sortMarksByPosition([])).toEqual([])
  })

  it('点选：加入、取消、满员时挤掉最早选的', () => {
    expect(togglePick([], 1)).toEqual([1])
    expect(togglePick([1], 2)).toEqual([1, 2])
    expect(togglePick([1, 2], 3)).toEqual([2, 3])
    expect(togglePick([1, 2], 1)).toEqual([2])
    expect(togglePick([2, 3], 3)).toEqual([2])
  })

  it('点选不改动入参，且上限为 2', () => {
    const picked = [1, 2]
    togglePick(picked, 3)
    expect(picked).toEqual([1, 2])
    expect(COMPARE_MAX).toBe(2)
  })

  it('间距取绝对值，与选择先后无关', () => {
    expect(gapMm(30, 12.5)).toBeCloseTo(17.5, 9)
    expect(gapMm(12.5, 30)).toBeCloseTo(17.5, 9)
    expect(gapMm(5, 5)).toBe(0)
  })
})

describe('scaleFromDpi / resolveScale', () => {
  it('ydpi 优先，除以像素比换成 CSS 像素', () => {
    expect(scaleFromDpi({ xdpi: 400, ydpi: 254 }, 2)).toBeCloseTo(5, 5)
    expect(scaleFromDpi({ xdpi: 254, ydpi: null }, 1)).toBeCloseTo(10, 5)
  })
  it('数据缺失或非法返回 null', () => {
    expect(scaleFromDpi(null, 2)).toBeNull()
    expect(scaleFromDpi({ xdpi: null, ydpi: null }, 2)).toBeNull()
    expect(scaleFromDpi({ ydpi: 0 }, 2)).toBeNull()
    expect(scaleFromDpi({ ydpi: 400 }, 0)).toBeNull()
    expect(scaleFromDpi({ ydpi: 400 }, Number.NaN)).toBeNull()
  })
  it('超出合理范围返回 null', () => {
    expect(scaleFromDpi({ ydpi: 5 }, 1)).toBeNull()
    expect(scaleFromDpi({ ydpi: 9000 }, 1)).toBeNull()
  })
  it('手动校准优先，其次自动，最后 96dpi', () => {
    expect(resolveScale(5, 6)).toBe(5)
    expect(resolveScale(null, 6)).toBe(6)
    expect(resolveScale(null, null)).toBe(DEFAULT_PX_PER_MM)
  })
})
