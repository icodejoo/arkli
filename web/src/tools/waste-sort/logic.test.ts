import { describe, expect, it } from 'vitest'
import { CATS, parseLines, WASTE_ITEMS, type WasteItem } from './data'
import {
  countByCat, findDuplicates, getCat, normalizeQuery, SCORE_ALIAS_EXACT, SCORE_NAME_EXACT, search,
} from './logic'

/** 合法分类集合 */
const VALID = new Set(CATS.map((c) => c.id))

/** 造词条 */
const it_ = (name: string, alias: string[] = []): WasteItem => ({ name, alias, cat: 'dry', tip: '' })

describe('词典数据', () => {
  it('至少 400 条', () => {
    expect(WASTE_ITEMS.length).toBeGreaterThanOrEqual(400)
  })

  it('名称与别名全表无重复', () => {
    expect(findDuplicates()).toEqual([])
  })

  it('每条分类合法、名称非空', () => {
    for (const i of WASTE_ITEMS) {
      expect(VALID.has(i.cat), i.name).toBe(true)
      expect(i.name.trim().length, i.name).toBeGreaterThan(0)
      for (const a of i.alias) expect(a.trim().length, i.name).toBeGreaterThan(0)
    }
  })

  it('四类都有词条', () => {
    const c = countByCat()
    for (const k of VALID) expect(c[k]).toBeGreaterThan(0)
  })

  it('几个典型条目分类正确', () => {
    const cat = (n: string) => search(n)[0].item.cat
    expect(cat('报纸')).toBe('recyclable')
    expect(cat('易拉罐')).toBe('recyclable')
    expect(cat('废电池')).toBe('hazardous')
    expect(cat('过期药品')).toBe('hazardous')
    expect(cat('剩饭')).toBe('wet')
    expect(cat('苹果核')).toBe('wet')
    expect(cat('烟蒂')).toBe('dry')
    expect(cat('纸尿裤')).toBe('dry')
  })

  it('分类展示信息齐全且 id 不重复', () => {
    expect(new Set(CATS.map((c) => c.id)).size).toBe(4)
    for (const c of CATS) {
      expect(c.name).toBeTruthy()
      expect(c.tip).toBeTruthy()
      expect(c.color).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })
})

describe('parseLines', () => {
  it('解析名称、别名、提示，忽略空行', () => {
    const r = parseLines('\n报纸|旧报纸, 报刊|压平\n\n杂志\n', 'recyclable')
    expect(r).toEqual([
      { name: '报纸', alias: ['旧报纸', '报刊'], cat: 'recyclable', tip: '压平' },
      { name: '杂志', alias: [], cat: 'recyclable', tip: '' },
    ])
  })

  it('名称为空的行被忽略', () => {
    expect(parseLines('|别名|提示', 'dry')).toEqual([])
  })
})

describe('normalizeQuery', () => {
  it('去空白、转小写', () => {
    expect(normalizeQuery('  U 盘 ')).toBe('u盘')
    expect(normalizeQuery('   ')).toBe('')
  })
})

describe('search 排序', () => {
  const dict = [
    it_('旧报纸堆'),
    it_('报纸', ['报刊']),
    it_('报纸夹'),
    it_('纸', ['白纸']),
    it_('废报纸'),
  ]

  it('空查询返回空', () => {
    expect(search('', dict)).toEqual([])
    expect(search('  ', dict)).toEqual([])
  })

  it('精确 > 前缀 > 包含，同档短名在前', () => {
    const r = search('报纸', dict).map((h) => h.item.name)
    expect(r).toEqual(['报纸', '报纸夹', '废报纸', '旧报纸堆'])
  })

  it('名称精确得分最高', () => {
    expect(search('报纸', dict)[0].score).toBe(SCORE_NAME_EXACT)
  })

  it('别名精确命中，并记录命中的别名', () => {
    const h = search('报刊', dict)[0]
    expect(h.item.name).toBe('报纸')
    expect(h.score).toBe(SCORE_ALIAS_EXACT)
    expect(h.matchedAlias).toBe('报刊')
  })

  it('名称命中不记别名', () => {
    expect(search('报纸', dict)[0].matchedAlias).toBe('')
  })

  it('输入里带有词条名也能反向命中', () => {
    const r = search('一大堆报纸', [it_('报纸')])
    expect(r).toHaveLength(1)
  })

  it('单字词条不做反向命中', () => {
    expect(search('一大堆纸张', [it_('纸')])).toEqual([])
  })

  it('大小写不敏感', () => {
    expect(search('u盘', [it_('U盘')])).toHaveLength(1)
  })

  it('limit 生效', () => {
    const many = Array.from({ length: 50 }, (_, i) => it_(`纸${i}`))
    expect(search('纸', many, 5)).toHaveLength(5)
  })

  it('查不到返回空', () => {
    expect(search('不存在的东西xyz')).toEqual([])
  })
})

describe('真实词典检索', () => {
  it('"电池"能搜到有害垃圾且排在前面', () => {
    const r = search('电池')
    expect(r[0].item.cat).toBe('hazardous')
  })

  it('别名可搜：旧报纸 -> 报纸', () => {
    expect(search('旧报纸')[0].item.name).toBe('报纸')
  })
})

describe('getCat / countByCat / findDuplicates', () => {
  it('getCat', () => {
    expect(getCat('wet')?.name).toBe('湿垃圾')
    expect(getCat('xx' as never)).toBeUndefined()
  })

  it('countByCat 总数等于词条数', () => {
    const c = countByCat()
    expect(c.recyclable + c.hazardous + c.wet + c.dry).toBe(WASTE_ITEMS.length)
  })

  it('findDuplicates 能发现名称与别名互撞', () => {
    expect(findDuplicates([it_('a', ['b']), it_('b')])).toEqual(['b'])
    expect(findDuplicates([it_('a'), it_('a')])).toEqual(['a'])
    expect(findDuplicates([it_('a', ['x', 'x'])])).toEqual([])
  })
})
