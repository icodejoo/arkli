import { describe, expect, it } from 'vitest'
import { SolarDay } from 'tyme4ts'
import { NO_NOTE_TEXT, tabooNote } from './logic'
import { TABOO_NOTES } from './taboo-notes'

/** 释义长度下限（字） */
const MIN_LEN = 4
/** 释义长度上限（字） */
const MAX_LEN = 80
/** 库里完整事项名：取任一宜忌项所属的 Taboo 类的静态词表 */
const LIB_NAMES: string[] = (() => {
  const t = SolarDay.fromYmd(2026, 10, 13).getSixtyCycleDay().getRecommends()[0]!
  return (t.constructor as unknown as { NAMES: string[] }).NAMES
})()

describe('宜忌释义表完整性', () => {
  it('库词表有 140 项且无重复（库升级后数量变化会在这里提醒）', () => {
    expect(LIB_NAMES).toHaveLength(140)
    expect(new Set(LIB_NAMES).size).toBe(LIB_NAMES.length)
  })

  it('库里每一项都有释义（防漏项）', () => {
    expect(LIB_NAMES.filter((n) => !(n in TABOO_NOTES))).toEqual([])
  })

  it('释义表没有库里不存在的多余或拼错的键', () => {
    expect(Object.keys(TABOO_NOTES).filter((k) => !LIB_NAMES.includes(k))).toEqual([])
  })

  it('每条释义非空、长度合理', () => {
    for (const [k, v] of Object.entries(TABOO_NOTES)) {
      expect(v.text.trim().length, k).toBeGreaterThanOrEqual(MIN_LEN)
      expect(v.text.length, k).toBeLessThanOrEqual(MAX_LEN)
    }
  })
})

describe('来源字段', () => {
  it('source 如有则非空且不含网址', () => {
    for (const [k, v] of Object.entries(TABOO_NOTES)) {
      if (v.source === undefined) continue
      expect(v.source.trim().length, k).toBeGreaterThan(0)
      expect(v.source, k).not.toMatch(/https?:|www\./)
    }
  })

  it('核对过的 17 条都带来源，并且 verify 的是少数', () => {
    const checked = ['出火', '合帐', '订盟', '启钻', '行丧', '开柱眼', '穿屏扇架', '塞穴', '架马', '安机械', '安机', '经络', '酝酿', '割蜜', '安碓磑', '断蚁', '归岫']
    for (const k of checked) expect(TABOO_NOTES[k]!.source, k).toBeTruthy()
    expect(checked.filter((k) => TABOO_NOTES[k]!.verify).length).toBeLessThan(checked.length)
  })
})

describe('tabooNote 查找', () => {
  it('命中返回释义与待核对标记', () => {
    expect(tabooNote('嫁娶')).toEqual({ text: TABOO_NOTES['嫁娶']!.text, verify: false, source: '' })
    expect(tabooNote('归岫').verify).toBe(true)
    expect(tabooNote('安碓磑').source).toContain('协纪辨方书')
    expect(tabooNote('馀事勿取').text).toContain('没有别的适合')
    expect(tabooNote('诸事不宜').text).toContain('不适合安排大事')
  })

  it('未命中返回「暂无说明」，不抛错（含 toString 之类原型键）', () => {
    expect(tabooNote('不存在的事项')).toEqual({ text: NO_NOTE_TEXT, verify: false, source: '' })
    expect(tabooNote('toString')).toEqual({ text: NO_NOTE_TEXT, verify: false, source: '' })
    expect(tabooNote('')).toEqual({ text: NO_NOTE_TEXT, verify: false, source: '' })
  })
})
