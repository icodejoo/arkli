import { describe, expect, it } from 'vitest'
import {
  addCategory, categoryShares, csvCell, CSV_BOM, DEFAULT_CATEGORIES, dateStrToTs, filterMonth, formatCents, isEntry,
  MAX_CATEGORIES, MAX_CENTS, monthKey, monthRange, newId, normalizeCategory, parseAmountToCents, parseImport,
  pickNewEntries, removeCategory, shiftMonth, shouldRemindBackup, summarize, toBackupJson, toCsv, tsToDateStr,
  type Entry,
} from './logic'

/** 本地时间戳 */
const t = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime()
/** 造账目 */
const mk = (id: string, kind: 'in' | 'out', cents: number, category: string, ts: number, note = ''): Entry => ({
  id, kind, amountCents: cents, category, ts, note,
})

describe('parseAmountToCents', () => {
  it('常见写法', () => {
    expect(parseAmountToCents('12')).toBe(1200)
    expect(parseAmountToCents('12.3')).toBe(1230)
    expect(parseAmountToCents('12.34')).toBe(1234)
    expect(parseAmountToCents('0.05')).toBe(5)
    expect(parseAmountToCents('.5')).toBe(50)
    expect(parseAmountToCents('12.')).toBe(1200)
    expect(parseAmountToCents(' 1,234.5 ')).toBe(123450)
  })

  it('不用浮点：19.99 与 0.07 精确', () => {
    expect(parseAmountToCents('19.99')).toBe(1999)
    expect(parseAmountToCents('0.07')).toBe(7)
  })

  it('非法输入返回 null', () => {
    for (const s of ['', ' ', '.', '-3', '+3', '0', '0.00', '1.234', 'abc', '1e3', '1.2.3']) {
      expect(parseAmountToCents(s)).toBeNull()
    }
  })

  it('超长与超上限', () => {
    expect(parseAmountToCents('99999999999')).toBeNull()
    expect(parseAmountToCents('999999999.99')).toBe(MAX_CENTS)
    expect(parseAmountToCents('1000000000')).toBeNull()
  })
})

describe('formatCents', () => {
  it('补零与负数', () => {
    expect(formatCents(1230)).toBe('12.30')
    expect(formatCents(5)).toBe('0.05')
    expect(formatCents(0)).toBe('0.00')
    expect(formatCents(-5)).toBe('-0.05')
    expect(formatCents(-123456)).toBe('-1234.56')
  })
})

describe('月份工具', () => {
  it('monthKey 与跨月边界', () => {
    expect(monthKey(new Date(2026, 0, 31, 23, 59, 59).getTime())).toBe('2026-01')
    expect(monthKey(new Date(2026, 1, 1, 0, 0, 0).getTime())).toBe('2026-02')
  })

  it('monthRange 左闭右开', () => {
    const r = monthRange('2026-02')!
    expect(r.start).toBe(new Date(2026, 1, 1).getTime())
    expect(r.end).toBe(new Date(2026, 2, 1).getTime())
    expect(monthRange('2026-13')).toBeNull()
    expect(monthRange('x')).toBeNull()
    expect(monthRange('2026-00')).toBeNull()
  })

  it('shiftMonth 跨年', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2025-12', 1)).toBe('2026-01')
    expect(shiftMonth('2026-05', 0)).toBe('2026-05')
    expect(shiftMonth('bad', 1)).toBe('bad')
  })

  it('filterMonth 边界与排序', () => {
    const es = [
      mk('a', 'out', 100, '餐饮', new Date(2026, 0, 31, 23, 59, 59).getTime()),
      mk('b', 'out', 100, '餐饮', new Date(2026, 1, 1, 0, 0, 0).getTime()),
      mk('c', 'out', 100, '餐饮', t(2026, 2, 10)),
    ]
    expect(filterMonth(es, '2026-02').map((e) => e.id)).toEqual(['c', 'b'])
    expect(filterMonth(es, '2026-01').map((e) => e.id)).toEqual(['a'])
    expect(filterMonth(es, 'bad')).toEqual([])
  })
})

describe('summarize / categoryShares', () => {
  const es = [
    mk('1', 'out', 8000, '餐饮', 1),
    mk('2', 'out', 2000, '交通', 2),
    mk('3', 'in', 50000, '工资', 3),
  ]

  it('合计与结余', () => {
    expect(summarize(es)).toEqual({ income: 50000, expense: 10000, balance: 40000 })
    expect(summarize([])).toEqual({ income: 0, expense: 0, balance: 0 })
  })

  it('支出占比降序', () => {
    expect(categoryShares(es, 'out')).toEqual([
      { category: '餐饮', cents: 8000, percent: 80 },
      { category: '交通', cents: 2000, percent: 20 },
    ])
  })

  it('同类合并，同额按名排序，无数据为空', () => {
    const x = [mk('1', 'out', 100, 'b', 1), mk('2', 'out', 100, 'a', 2), mk('3', 'out', 100, 'a', 3)]
    expect(categoryShares(x, 'out').map((s) => s.category)).toEqual(['a', 'b'])
    expect(categoryShares(es, 'in')).toHaveLength(1)
    expect(categoryShares([], 'out')).toEqual([])
  })

  it('百分比保留一位小数', () => {
    const x = [mk('1', 'out', 1, 'a', 1), mk('2', 'out', 2, 'b', 2)]
    expect(categoryShares(x, 'out').map((s) => s.percent)).toEqual([66.7, 33.3])
  })
})

describe('newId / 日期', () => {
  it('id 随时间有序且长度固定', () => {
    const a = newId(1000, () => 0)
    const b = newId(2000, () => 0)
    expect(a < b).toBe(true)
    expect(a.length).toBe(b.length)
    expect(newId(1000, () => 0.999999).length).toBe(a.length)
  })

  it('tsToDateStr / dateStrToTs 往返', () => {
    expect(tsToDateStr(t(2026, 3, 5))).toBe('2026-03-05')
    expect(dateStrToTs('2026-03-05')).toBe(t(2026, 3, 5))
  })

  it('不存在的日期返回 null', () => {
    expect(dateStrToTs('2026-02-30')).toBeNull()
    expect(dateStrToTs('2026-2-3')).toBeNull()
    expect(dateStrToTs('')).toBeNull()
  })
})

describe('分类', () => {
  it('normalizeCategory', () => {
    expect(normalizeCategory('  宠物 ')).toBe('宠物')
    expect(normalizeCategory('')).toBeNull()
    expect(normalizeCategory('一二三四五六七八九')).toBeNull()
  })

  it('addCategory 去重、非法、上限', () => {
    expect(addCategory(['餐饮'], '宠物')).toEqual(['餐饮', '宠物'])
    const l = ['餐饮']
    expect(addCategory(l, '餐饮')).toBe(l)
    expect(addCategory(l, ' ')).toBe(l)
    const full = Array.from({ length: MAX_CATEGORIES }, (_, i) => `c${i}`)
    expect(addCategory(full, '新')).toBe(full)
  })

  it('removeCategory 至少留一个', () => {
    expect(removeCategory(['a', 'b'], 'a')).toEqual(['b'])
    const one = ['a']
    expect(removeCategory(one, 'a')).toBe(one)
  })
})

describe('CSV', () => {
  it('csvCell 转义', () => {
    expect(csvCell('abc')).toBe('abc')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('l1\nl2')).toBe('"l1\nl2"')
    expect(csvCell('=1+1')).toBe("'=1+1")
    expect(csvCell('@x,y')).toBe('"\'@x,y"')
  })

  it('toCsv 带 BOM、表头、CRLF、按时间正序', () => {
    const es = [
      mk('2', 'in', 100000, '工资', t(2026, 1, 2), '发薪'),
      mk('1', 'out', 1250, '餐饮', t(2026, 1, 1), '午饭, 加蛋'),
    ]
    const csv = toCsv(es)
    expect(csv.startsWith(CSV_BOM + '日期,类型,分类,金额,备注\r\n')).toBe(true)
    const lines = csv.split('\r\n')
    expect(lines[1]).toBe('2026-01-01,支出,餐饮,12.50,"午饭, 加蛋"')
    expect(lines[2]).toBe('2026-01-02,收入,工资,1000.00,发薪')
    expect(lines[3]).toBe('')
  })

  it('空账目只有表头', () => {
    expect(toCsv([])).toBe(CSV_BOM + '日期,类型,分类,金额,备注\r\n')
  })
})

describe('备份导出与导入', () => {
  const es = [mk('a', 'out', 1250, '餐饮', t(2026, 1, 1), '午饭'), mk('b', 'in', 500000, '工资', t(2026, 1, 2))]

  it('导出再导入数据一致', () => {
    const r = parseImport(toBackupJson(es, DEFAULT_CATEGORIES, 1))
    expect(r.entries).toEqual(es)
    expect(r.categories).toEqual(DEFAULT_CATEGORIES)
    expect(r.skipped).toBe(0)
  })

  it('备份头部信息', () => {
    const j = JSON.parse(toBackupJson(es, DEFAULT_CATEGORIES, 123))
    expect(j).toMatchObject({ app: 'arkli', schema: 1, exportedAt: 123 })
  })

  it('接受裸数组与 tools.ledger 数组，带 BOM 也行', () => {
    expect(parseImport(JSON.stringify(es)).entries).toEqual(es)
    expect(parseImport(JSON.stringify({ tools: { ledger: es } })).entries).toEqual(es)
    expect(parseImport('﻿' + JSON.stringify(es)).entries).toEqual(es)
  })

  it('无效条目计入 skipped', () => {
    const bad = [es[0], { id: 'x', amountCents: -5, kind: 'out', category: 'a', note: '', ts: 1 }, null, { id: 'y' }]
    const r = parseImport(JSON.stringify(bad))
    expect(r.entries).toHaveLength(1)
    expect(r.skipped).toBe(3)
  })

  it('错误输入抛错', () => {
    expect(() => parseImport('not json')).toThrow('JSON')
    expect(() => parseImport('{}')).toThrow('没有找到')
    expect(() => parseImport('123')).toThrow('没有找到')
  })

  it('备注超长被截断；缺分类时 categories 为空', () => {
    const long = { ...es[0], note: 'x'.repeat(500) }
    const r = parseImport(JSON.stringify({ tools: { ledger: { entries: [long], categories: { out: [] } } } }))
    expect(r.entries[0].note.length).toBe(100)
    expect(r.categories).toBeUndefined()
  })
})

describe('isEntry / pickNewEntries', () => {
  it('isEntry', () => {
    expect(isEntry(mk('a', 'in', 1, 'x', 1))).toBe(true)
    expect(isEntry({ ...mk('a', 'in', 1, 'x', 1), amountCents: 1.5 })).toBe(false)
    expect(isEntry({ ...mk('a', 'in', 1, 'x', 1), kind: 'foo' })).toBe(false)
    expect(isEntry({ ...mk('a', 'in', 1, 'x', 1), ts: NaN })).toBe(false)
    expect(isEntry(undefined)).toBe(false)
  })

  it('已存在的 id 不覆盖，导入内部重复只留一条', () => {
    const local = [mk('a', 'in', 1, 'x', 1)]
    const inc = [mk('a', 'in', 999, 'x', 1), mk('b', 'in', 2, 'x', 2), mk('b', 'in', 3, 'x', 2)]
    expect(pickNewEntries(local, inc).map((e) => e.amountCents)).toEqual([2])
  })
})

describe('shouldRemindBackup', () => {
  const DAY = 86400000
  it('没有数据不提醒', () => {
    expect(shouldRemindBackup(0, undefined, 1e12)).toBe(false)
  })

  it('从没导出：满 50 条才提醒', () => {
    expect(shouldRemindBackup(49, undefined, 1e12)).toBe(false)
    expect(shouldRemindBackup(50, undefined, 1e12)).toBe(true)
  })

  it('导出过：超过 30 天才提醒', () => {
    const now = 1e12
    expect(shouldRemindBackup(5, now - 30 * DAY, now)).toBe(false)
    expect(shouldRemindBackup(5, now - 31 * DAY, now)).toBe(true)
  })
})
