import { describe, expect, it } from 'vitest'
import { BUILTIN_IDIOMS } from './data'
import {
  builtinSource,
  chainNext,
  findIdiom,
  initials,
  lastChar,
  MAX_RESULTS,
  randomIdiom,
  searchIdioms,
  stripTone,
  type Idiom,
} from './logic'

/** 测试用小词库，覆盖精确/前缀/包含/释义命中 */
const MINI: Idiom[] = [
  { word: '心', pinyin: 'xīn', meaning: '心脏' },
  { word: '心花怒放', pinyin: 'xīn huā nù fàng', meaning: '高兴极了。' },
  { word: '一心一意', pinyin: 'yī xīn yī yì', meaning: '专一。' },
  { word: '三心二意', pinyin: 'sān xīn èr yì', meaning: '犹豫不决。' },
  { word: '安分守己', pinyin: 'ān fèn shǒu jǐ', meaning: '规矩，心里踏实。' },
]

describe('数据校验', () => {
  const all = builtinSource.all()

  it('数据源返回内置词库且非空', () => {
    expect(all).toBe(BUILTIN_IDIOMS)
    expect(all.length).toBeGreaterThan(300)
  })

  it('没有重复成语', () => {
    const words = all.map((i) => i.word)
    expect(new Set(words).size).toBe(words.length)
  })

  it('拼音音节数等于字数，且格式规范', () => {
    const bad = all.filter((i) => {
      const syl = i.pinyin.split(' ')
      return syl.length !== Array.from(i.word).length || syl.some((s) => !/^[a-züāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]+$/.test(s))
    })
    expect(bad.map((i) => i.word)).toEqual([])
  })

  it('每条释义非空且不超过 40 字', () => {
    const bad = all.filter((i) => !i.meaning.trim() || Array.from(i.meaning).length > 40)
    expect(bad.map((i) => i.word)).toEqual([])
  })

  it('词条全是汉字，四字成语占比不低于 90%', () => {
    expect(all.filter((i) => !/^[一-鿿]+$/.test(i.word)).map((i) => i.word)).toEqual([])
    const four = all.filter((i) => Array.from(i.word).length === 4).length
    expect(four / all.length).toBeGreaterThanOrEqual(0.9)
  })

  it('多音字特例读音正确', () => {
    expect(findIdiom(all, '差强人意')?.pinyin).toBe('chā qiáng rén yì')
    expect(findIdiom(all, '一曝十寒')?.pinyin).toBe('yī pù shí hán')
    expect(findIdiom(all, '爱不释手')?.pinyin).toBe('ài bù shì shǒu')
  })
})

describe('stripTone', () => {
  it('去声调、去空格、小写', () => {
    expect(stripTone('Yī xīn yī yì')).toBe('yixinyiyi')
  })
  it('ü 与 v 统一为 u', () => {
    expect(stripTone('lǜ')).toBe('lu')
    expect(stripTone('lv')).toBe('lu')
  })
})

describe('initials', () => {
  it('取每个音节首字母', () => {
    expect(initials('yì qì fēng fā')).toBe('yqff')
  })
  it('空串返回空串', () => {
    expect(initials('')).toBe('')
  })
})

describe('searchIdioms', () => {
  it('空查询返回空数组', () => {
    expect(searchIdioms(MINI, '  ')).toEqual([])
  })

  it('汉字排序：精确 > 前缀 > 包含 > 释义命中', () => {
    const r = searchIdioms(MINI, '心').map((h) => h.idiom.word)
    expect(r).toEqual(['心', '心花怒放', '一心一意', '三心二意', '安分守己'])
  })

  it('汉字查询不命中返回空', () => {
    expect(searchIdioms(MINI, '龙')).toEqual([])
  })

  it('带声调拼音', () => {
    expect(searchIdioms(MINI, 'yī xīn')[0].idiom.word).toBe('一心一意')
  })

  it('无声调拼音（含空格）', () => {
    expect(searchIdioms(MINI, 'yi xin yi')[0].idiom.word).toBe('一心一意')
  })

  it('首字母缩写', () => {
    expect(searchIdioms(MINI, 'yxyy')[0].idiom.word).toBe('一心一意')
    expect(searchIdioms(MINI, 'XHNF')[0].idiom.word).toBe('心花怒放')
  })

  it('带调查询区分声调', () => {
    expect(searchIdioms(MINI, 'ān fèn').map((h) => h.idiom.word)).toEqual(['安分守己'])
    expect(searchIdioms(MINI, 'àn fèn')).toEqual([])
  })

  it('限制条数', () => {
    expect(searchIdioms(BUILTIN_IDIOMS, 'yi').length).toBeLessThanOrEqual(MAX_RESULTS)
    expect(searchIdioms(MINI, 'x', 2)).toHaveLength(2)
  })

  it('真实词库：缩写与释义检索', () => {
    const all = builtinSource.all()
    expect(searchIdioms(all, 'yxyy').map((h) => h.idiom.word)).toContain('一心一意')
    expect(searchIdioms(all, '精神振奋').map((h) => h.idiom.word)).toContain('意气风发')
  })
})

describe('lastChar', () => {
  it('取末字', () => {
    expect(lastChar('一心一意')).toBe('意')
  })
  it('空串返回空串', () => {
    expect(lastChar('')).toBe('')
  })
})

describe('chainNext', () => {
  it('真实词库：一心一意 能接 意气风发', () => {
    const all = builtinSource.all()
    const cur = findIdiom(all, '一心一意')!
    const words = chainNext(all, cur).map((c) => c.idiom.word)
    expect(words).toContain('意气风发')
    expect(words).not.toContain('一心一意')
    expect(chainNext(all, cur).every((c) => Array.from(c.idiom.word)[0] === '意')).toBe(true)
  })

  it('同字不同音标注 diffSound，同音排前面', () => {
    const cur: Idiom = { word: '甲乙行', pinyin: 'jiǎ yǐ xíng', meaning: '测试' }
    const items: Idiom[] = [
      cur,
      { word: '行业', pinyin: 'háng yè', meaning: '测试' },
      { word: '行走', pinyin: 'xíng zǒu', meaning: '测试' },
    ]
    const r = chainNext(items, cur)
    expect(r.map((c) => [c.idiom.word, c.diffSound])).toEqual([
      ['行走', false],
      ['行业', true],
    ])
  })

  it('无可接时返回空数组', () => {
    expect(chainNext(MINI, MINI[4])).toEqual([])
  })
})

describe('randomIdiom', () => {
  it('按注入的随机数取', () => {
    expect(randomIdiom(MINI, () => 0)).toBe(MINI[0])
    expect(randomIdiom(MINI, () => 0.999999)).toBe(MINI[MINI.length - 1])
  })
  it('空列表返回 undefined', () => {
    expect(randomIdiom([])).toBeUndefined()
  })
})

describe('findIdiom', () => {
  it('找到与找不到', () => {
    expect(findIdiom(MINI, '一心一意')?.pinyin).toBe('yī xīn yī yì')
    expect(findIdiom(MINI, '不存在')).toBeUndefined()
  })
})

describe('builtinSource', () => {
  it('all 返回数组', () => {
    expect(Array.isArray(builtinSource.all())).toBe(true)
  })
})
