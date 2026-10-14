import { describe, expect, it } from 'vitest'
import { CARRIERS } from './data'
import { identify, MAX_HISTORY, normalizeNo, pushHistory } from './logic'

/** 取候选公司 id 列表 */
const ids = (s: string) => identify(s).candidates.map((c) => c.carrier.id)

describe('normalizeNo', () => {
  it('去空白连字符、转大写', () => {
    expect(normalizeNo(' sf-1234 5678 ')).toBe('SF12345678')
  })

  it('全角转半角', () => {
    expect(normalizeNo('ＳＦ１２３４')).toBe('SF1234')
  })

  it('空串', () => {
    expect(normalizeNo('   ')).toBe('')
  })
})

describe('identify 输入校验', () => {
  it('空输入', () => {
    expect(identify('').error).toBe('请输入快递单号')
  })

  it('含非法字符', () => {
    expect(identify('SF123456789!@').error).toContain('字母和数字')
    expect(identify('顺丰12345678').error).toContain('字母和数字')
  })

  it('过短与过长', () => {
    expect(identify('SF123').error).toContain('长度')
    expect(identify('1'.repeat(31)).error).toContain('长度')
  })

  it('合法但没有规则命中：无错误无候选', () => {
    const r = identify('ABCDEFGH9')
    expect(r.error).toBe('')
    expect(r.candidates).toEqual([])
  })
})

describe('identify 各家规则', () => {
  it('顺丰 SF 前缀排第一', () => {
    expect(ids('SF1234567890123')[0]).toBe('sf')
    expect(identify('sf 1234567890123').candidates[0].confidence).toBe(3)
  })

  it('京东 JD / JDVA', () => {
    expect(ids('JD0012345678901')).toEqual(['jd'])
    expect(ids('JDVA12345678901')).toEqual(['jd'])
  })

  it('中通 78 开头 12 位：中通可信度高于顺丰/申通的兜底', () => {
    const r = ids('781234567890')
    expect(r[0]).toBe('zto')
    expect(r).toContain('sf')
    expect(r).toContain('sto')
  })

  it('圆通 YT + 13 位', () => {
    expect(ids('YT1234567890123')).toEqual(['yto'])
  })

  it('申通 268 与 77', () => {
    expect(ids('268123456789')[0]).toBe('sto')
    expect(ids('771234567890')[0]).toBe('sto')
  })

  it('极兔 JT', () => {
    expect(ids('JT5012345678901')).toEqual(['jt'])
  })

  it('邮政 EMS 国际格式与 CN 结尾', () => {
    expect(ids('EA123456789CN')).toEqual(['ems'])
    expect(ids('RA123456789CN')).toEqual(['ems'])
  })

  it('邮政 11 位 10 开头、13 位 9 开头', () => {
    expect(ids('10123456789')).toEqual(['ems'])
    expect(ids('9876543210123')).toEqual(['ems'])
  })

  it('德邦 DPK', () => {
    expect(ids('DPK123456789012')).toEqual(['deppon'])
  })

  it('韵达 13 位 1x 开头', () => {
    expect(ids('1012345678901')).toEqual(['yunda'])
  })

  it('同一公司多规则命中只出现一次且取最高可信度', () => {
    const c = identify('781234567890').candidates.filter((x) => x.carrier.id === 'zto')
    expect(c).toHaveLength(1)
    expect(c[0].confidence).toBe(2)
  })
})

describe('规则表自检', () => {
  it('公司 id 不重复，官网为 https', () => {
    const idList = CARRIERS.map((c) => c.id)
    expect(new Set(idList).size).toBe(idList.length)
    for (const c of CARRIERS) expect(c.url.startsWith('https://')).toBe(true)
  })

  it('每家至少一条规则，说明非空', () => {
    for (const c of CARRIERS) {
      expect(c.rules.length).toBeGreaterThan(0)
      for (const r of c.rules) expect(r.note.length).toBeGreaterThan(0)
    }
  })
})

describe('pushHistory', () => {
  it('新单号放最前并去重', () => {
    expect(pushHistory(['A', 'B'], 'B')).toEqual(['B', 'A'])
    expect(pushHistory(['A'], 'C')).toEqual(['C', 'A'])
  })

  it('空单号不动，超长截断', () => {
    const l = ['A']
    expect(pushHistory(l, '')).toBe(l)
    const many = Array.from({ length: MAX_HISTORY }, (_, i) => `N${i}`)
    expect(pushHistory(many, 'NEW')).toHaveLength(MAX_HISTORY)
    expect(pushHistory(many, 'NEW')[0]).toBe('NEW')
  })
})
