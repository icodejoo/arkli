import { describe, expect, it } from 'vitest'
import { describeCron, formatRun, nextRuns, parseCron, type CronExpr } from './logic'

/** 解析并断言成功 */
function expr(s: string): CronExpr {
  const r = parseCron(s)
  if (!r.ok) throw new Error(r.error)
  return r.expr
}
/** 解析失败时的错误文案 */
function err(s: string): string {
  const r = parseCron(s)
  return r.ok ? '' : r.error
}

describe('parseCron', () => {
  it('展开 * , - /', () => {
    expect(expr('*/15 * * * *').minute.values).toEqual([0, 15, 30, 45])
    expect(expr('0 9-11,20 * * *').hour.values).toEqual([9, 10, 11, 20])
    expect(expr('5/20 * * * *').minute.values).toEqual([5, 25, 45])
    expect(expr('0 0 1-10/3 * *').dom.values).toEqual([1, 4, 7, 10])
  })
  it('星期 7 归并为 0', () => {
    expect(expr('0 0 * * 5-7').dow.values).toEqual([0, 5, 6])
    expect(expr('0 0 * * *').dow.values).toEqual([0, 1, 2, 3, 4, 5, 6])
  })
  it('指明错在哪一段', () => {
    expect(err('60 * * * *')).toContain('第 1 段（分钟）')
    expect(err('* 24 * * *')).toContain('第 2 段（小时）')
    expect(err('* * 0 * *')).toContain('第 3 段（日）')
    expect(err('* * * 13 *')).toContain('第 4 段（月）')
    expect(err('* * * * 8')).toContain('第 5 段（星期）')
    expect(err('*/0 * * * *')).toContain('步长')
    expect(err('5-1 * * * *')).toContain('起点大于终点')
    expect(err('a * * * *')).toContain('不是合法数字')
    expect(err('1,,2 * * * *')).toContain('空的')
  })
  it('段数不对', () => {
    expect(err('')).toContain('请输入')
    expect(err('* * * *')).toContain('当前是 4 段')
    expect(err('* * * * * *')).toContain('当前是 6 段')
  })
})

describe('describeCron', () => {
  it('常见写法', () => {
    expect(describeCron(expr('* * * * *'))).toBe('每分钟')
    expect(describeCron(expr('*/5 * * * *'))).toBe('每 5 分钟')
    expect(describeCron(expr('0 8 * * *'))).toBe('每天 08:00')
    expect(describeCron(expr('30 9 * * 1-5'))).toBe('每周一至周五 09:30')
    expect(describeCron(expr('0 0 1 * *'))).toBe('每月1日 00:00')
    expect(describeCron(expr('0 * * * *'))).toBe('每小时整点')
    expect(describeCron(expr('0 0 1 1 *'))).toBe('1月的1日 00:00')
  })
  it('日与星期同时限定用"或"', () => {
    expect(describeCron(expr('0 0 13 * 5'))).toContain('13日或周五')
  })
})

describe('nextRuns', () => {
  const from = new Date(2026, 0, 5, 10, 7, 30) // 周一 10:07:30

  it('每 15 分钟', () => {
    const r = nextRuns(expr('*/15 * * * *'), from, 3).map(formatRun)
    expect(r).toEqual(['2026-01-05 周一 10:15', '2026-01-05 周一 10:30', '2026-01-05 周一 10:45'])
  })
  it('不含起算当前这一分钟', () => {
    const at = new Date(2026, 0, 5, 10, 15, 0)
    expect(nextRuns(expr('15 10 * * *'), at, 1).map(formatRun)).toEqual(['2026-01-06 周二 10:15'])
  })
  it('工作日 09:30 跳过周末', () => {
    const r = nextRuns(expr('30 9 * * 1-5'), new Date(2026, 0, 9, 12, 0), 2).map(formatRun)
    expect(r).toEqual(['2026-01-12 周一 09:30', '2026-01-13 周二 09:30'])
  })
  it('日与星期都限定取并集', () => {
    // 2026-01-13 是周二，13 日触发；之后最近的周五是 1-16
    const r = nextRuns(expr('0 0 13 * 5'), new Date(2026, 0, 10), 3).map(formatRun)
    expect(r).toEqual(['2026-01-13 周二 00:00', '2026-01-16 周五 00:00', '2026-01-23 周五 00:00'])
  })
  it('2 月 29 日跨闰年', () => {
    const r = nextRuns(expr('0 0 29 2 *'), new Date(2026, 0, 1), 1)
    expect(r[0].getFullYear()).toBe(2028)
  })
  it('永不触发返回空', () => {
    expect(nextRuns(expr('0 0 31 2 *'), from)).toEqual([])
  })
  it('默认 5 次', () => {
    expect(nextRuns(expr('* * * * *'), from)).toHaveLength(5)
  })
})
