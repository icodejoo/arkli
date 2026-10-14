import { describe, expect, it } from 'vitest'
import { CATEGORY_LABELS, ELEMENTS } from './data'
import { electronConfig, formatMass, gridPos, groupOf, isRadioactive, periodOf, searchElements } from './logic'

const bySym = (s: string) => ELEMENTS.find((e) => e.symbol === s)!

describe('ELEMENTS 数据', () => {
  it('共 118 个，序号连续', () => {
    expect(ELEMENTS).toHaveLength(118)
    ELEMENTS.forEach((e, i) => expect(e.z).toBe(i + 1))
  })
  it('符号、中文名、英文名都唯一', () => {
    expect(new Set(ELEMENTS.map((e) => e.symbol)).size).toBe(118)
    expect(new Set(ELEMENTS.map((e) => e.cn)).size).toBe(118)
    expect(new Set(ELEMENTS.map((e) => e.en)).size).toBe(118)
  })
  it('字段完整、分类合法、质量为正', () => {
    for (const e of ELEMENTS) {
      expect(e.symbol).toMatch(/^[A-Z][a-z]?$/)
      expect(e.en.length).toBeGreaterThan(2)
      expect(CATEGORY_LABELS[e.category]).toBeTruthy()
      expect(e.mass).toBeGreaterThan(0)
    }
  })
  it('92 号以前原子质量只有少数倒挂', () => {
    const inversions = ELEMENTS.filter((e, i) => i > 0 && e.z <= 92 && e.mass < ELEMENTS[i - 1].mass).map((e) => e.symbol)
    expect(inversions).toEqual(['K', 'Ni', 'I', 'Pa', 'Np'].filter((s) => inversions.includes(s)))
    expect(inversions.length).toBeLessThanOrEqual(5)
  })
  it('几个常用元素的数据正确', () => {
    expect(bySym('Fe')).toMatchObject({ z: 26, cn: '铁', en: 'Iron', mass: 55.845 })
    expect(bySym('Au')).toMatchObject({ z: 79, cn: '金', mass: 196.97 })
    expect(bySym('Og').z).toBe(118)
    expect(bySym('Mc').cn).toBe('镆')
    expect(bySym('Rf').read).toBe('lú')
  })
  it('分类抽查', () => {
    expect(bySym('Na').category).toBe('alkali')
    expect(bySym('Ca').category).toBe('alkaline')
    expect(bySym('Cl').category).toBe('halogen')
    expect(bySym('Ar').category).toBe('noble')
    expect(bySym('Nd').category).toBe('lanthanide')
    expect(bySym('U').category).toBe('actinide')
    expect(bySym('Si').category).toBe('metalloid')
  })
  it('镧系 15 个、锕系 15 个', () => {
    expect(ELEMENTS.filter((e) => e.category === 'lanthanide')).toHaveLength(15)
    expect(ELEMENTS.filter((e) => e.category === 'actinide')).toHaveLength(15)
  })
})

describe('periodOf / gridPos / groupOf', () => {
  it('周期划分', () => {
    expect(periodOf(1)).toBe(1)
    expect(periodOf(2)).toBe(1)
    expect(periodOf(3)).toBe(2)
    expect(periodOf(18)).toBe(3)
    expect(periodOf(86)).toBe(6)
    expect(periodOf(118)).toBe(7)
    expect(periodOf(0)).toBe(0)
    expect(periodOf(119)).toBe(0)
    expect(periodOf(1.5)).toBe(0)
  })
  it('所有元素网格位置互不重叠', () => {
    const keys = ELEMENTS.map((e) => {
      const p = gridPos(e.z)!
      return `${p.row},${p.col}`
    })
    expect(new Set(keys).size).toBe(118)
  })
  it('关键位置', () => {
    expect(gridPos(1)).toEqual({ row: 1, col: 1 })
    expect(gridPos(2)).toEqual({ row: 1, col: 18 })
    expect(gridPos(5)).toEqual({ row: 2, col: 13 })
    expect(gridPos(10)).toEqual({ row: 2, col: 18 })
    expect(gridPos(26)).toEqual({ row: 4, col: 8 })
    expect(gridPos(56)).toEqual({ row: 6, col: 2 })
    expect(gridPos(72)).toEqual({ row: 6, col: 4 })
    expect(gridPos(86)).toEqual({ row: 6, col: 18 })
    expect(gridPos(104)).toEqual({ row: 7, col: 4 })
    expect(gridPos(118)).toEqual({ row: 7, col: 18 })
    expect(gridPos(57)).toEqual({ row: 9, col: 3 })
    expect(gridPos(92)).toEqual({ row: 10, col: 6 })
    expect(gridPos(0)).toBeNull()
  })
  it('族号', () => {
    expect(groupOf(17)).toBe(17)
    expect(groupOf(26)).toBe(8)
    expect(groupOf(11)).toBe(1)
    expect(groupOf(60)).toBeNull()
    expect(groupOf(200)).toBeNull()
  })
})

describe('electronConfig', () => {
  it('常规元素', () => {
    expect(electronConfig(1)).toBe('1s1')
    expect(electronConfig(2)).toBe('1s2')
    expect(electronConfig(6)).toBe('[He]2s2 2p2')
    expect(electronConfig(11)).toBe('[Ne]3s1')
    expect(electronConfig(26)).toBe('[Ar]3d6 4s2')
    expect(electronConfig(35)).toBe('[Ar]3d10 4s2 4p5')
    expect(electronConfig(71)).toBe('[Xe]4f14 5d1 6s2')
  })
  it('例外元素按实际基态', () => {
    expect(electronConfig(24)).toBe('[Ar]3d5 4s1')
    expect(electronConfig(29)).toBe('[Ar]3d10 4s1')
    expect(electronConfig(46)).toBe('[Kr]4d10')
    expect(electronConfig(79)).toBe('[Xe]4f14 5d10 6s1')
    expect(electronConfig(57)).toBe('[Xe]5d1 6s2')
    expect(electronConfig(92)).toBe('[Rn]5f3 6d1 7s2')
    expect(electronConfig(103)).toBe('[Rn]5f14 7s2 7p1')
  })
  it('稀有气体用上一周期核', () => {
    expect(electronConfig(18)).toBe('[Ne]3s2 3p6')
    expect(electronConfig(118)).toBe('[Rn]5f14 6d10 7s2 7p6')
  })
  it('越界返回空串', () => {
    expect(electronConfig(0)).toBe('')
    expect(electronConfig(119)).toBe('')
  })
  it('电子总数等于原子序数', () => {
    const cores: Record<string, number> = { He: 2, Ne: 10, Ar: 18, Kr: 36, Xe: 54, Rn: 86 }
    for (let z = 1; z <= 118; z++) {
      const cfg = electronConfig(z)
      const m = /^\[(\w+)\]/.exec(cfg)
      const core = m ? cores[m[1]] : 0
      const nums = (cfg.match(/[spdf]\d+/g) ?? []).reduce((a, x) => a + Number(x.slice(1)), 0)
      expect(nums + core).toBe(z)
    }
  })
})

describe('searchElements', () => {
  it('空串返回全部', () => {
    expect(searchElements('  ')).toHaveLength(118)
  })
  it('按序号、符号、中文、英文查', () => {
    expect(searchElements('26').map((e) => e.symbol)).toEqual(['Fe'])
    expect(searchElements('fe').map((e) => e.symbol)).toContain('Fe')
    expect(searchElements('铁')[0].symbol).toBe('Fe')
    expect(searchElements('gold')[0].symbol).toBe('Au')
  })
  it('无结果返回空数组', () => {
    expect(searchElements('zzzzz')).toEqual([])
    expect(searchElements('999')).toEqual([])
  })
})

describe('formatMass / isRadioactive', () => {
  it('有标准原子量直接显示，否则加方括号', () => {
    expect(formatMass(bySym('Fe'))).toBe('55.845')
    expect(formatMass(bySym('Tc'))).toBe('[98]')
    expect(formatMass(bySym('Og'))).toBe('[294]')
    expect(formatMass(bySym('U'))).toBe('238.03')
  })
  it('放射性判断', () => {
    expect(isRadioactive(43)).toBe(true)
    expect(isRadioactive(61)).toBe(true)
    expect(isRadioactive(92)).toBe(true)
    expect(isRadioactive(82)).toBe(false)
    expect(isRadioactive(1)).toBe(false)
  })
})
