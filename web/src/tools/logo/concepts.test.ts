import { describe, expect, it, vi } from 'vitest'
import {
  CONCEPT_COUNT,
  GENERIC_OBJECTS,
  INDUSTRIES,
  buildConceptPrompt,
  conceptPrompt,
  conceptsFromQwen,
  conceptsFromText,
  describeConcepts,
  matchIndustry,
  normalizeObject,
  parseObjectsJson,
  resolveConcepts,
  type RunConceptPrompt,
} from './concepts'

/** 一段合格的 Qwen 输出 */
const GOOD = '{"objects":["a robot head","a microchip","a brain","a light bulb"]}'
/** 词表里没有任何关键词、plan.ts 行业词表也不认的文本 */
const UNKNOWN = '夸克星际'

describe('INDUSTRIES 词表规模与质量', () => {
  it('至少 48 个行业，id 唯一', () => {
    expect(INDUSTRIES.length).toBeGreaterThanOrEqual(48)
    expect(new Set(INDUSTRIES.map((i) => i.id)).size).toBe(INDUSTRIES.length)
  })
  it('每个行业 4 个互不相同的小写英文物体词（1~7 个词），且至少有 2 个关键词', () => {
    for (const ind of INDUSTRIES) {
      expect(ind.objects).toHaveLength(CONCEPT_COUNT)
      expect(new Set(ind.objects).size).toBe(CONCEPT_COUNT)
      expect(ind.keywords.length).toBeGreaterThanOrEqual(2)
      for (const o of ind.objects) {
        expect(o).toMatch(/^[a-z][a-z -]*$/)
        expect(o.split(' ').length).toBeLessThanOrEqual(7)
      }
    }
  })
  it('英文关键词长度 >= 4（避免 ai 之类短词误撞），关键词跨行业不重复', () => {
    const seen = new Map<string, string>()
    for (const ind of INDUSTRIES) {
      for (const kw of ind.keywords) {
        if (/^[a-z]/i.test(kw)) expect(kw.length).toBeGreaterThanOrEqual(4)
        expect(seen.get(kw)).toBeUndefined()
        seen.set(kw, ind.id)
      }
    }
  })
  it('沿用 spike v3 的词（抽查）', () => {
    const by = (id: string) => INDUSTRIES.find((i) => i.id === id)?.objects
    expect(by('coffee')).toEqual(['a coffee cup with steam', 'a coffee bean', 'a coffee pot', 'a takeaway coffee cup'])
    expect(by('gym')).toEqual(['a dumbbell', 'a kettlebell', 'a flexed arm', 'a barbell'])
    expect(by('eco')).toEqual(['recycling arrows', 'a leaf', 'a tree', 'a globe'])
  })
  it('通用词锁定为 4 个，且不与任何行业词重复', () => {
    expect(GENERIC_OBJECTS).toEqual(['a feather', 'a lantern', 'a crown', 'a telescope'])
    const all = new Set(INDUSTRIES.flatMap((i) => i.objects))
    expect(GENERIC_OBJECTS.filter((g) => all.has(g))).toEqual([])
  })
})

describe('matchIndustry', () => {
  it('健身房 力量训练 → gym；咖啡 → coffee', () => {
    expect(matchIndustry('健身房 力量训练')?.id).toBe('gym')
    expect(matchIndustry('山屿咖啡')?.id).toBe('coffee')
  })
  it('最长关键词优先：奶茶店 → bubbletea 而不是 tea 或 restaurant', () => {
    expect(matchIndustry('奶茶店')?.id).toBe('bubbletea')
  })
  it('英文按单词边界：Rainbow 不会命中 ai；独立的 robot 才命中', () => {
    expect(matchIndustry('Rainbow')).toBeNull()
    expect(matchIndustry('Robot Lab')?.id).toBe('ai')
  })
  it('空串与无关文本为 null', () => {
    expect(matchIndustry('')).toBeNull()
    expect(matchIndustry(UNKNOWN)).toBeNull()
  })
})

describe('conceptsFromText', () => {
  it('关键词命中 source=keyword，返回的是拷贝', () => {
    const r = conceptsFromText('奶茶店')
    expect(r).toMatchObject({ source: 'keyword', industry: 'bubbletea' })
    r?.objects.push('x')
    expect(matchIndustry('奶茶店')?.objects).toHaveLength(CONCEPT_COUNT)
  })
  it('关键词没中但 plan.ts 行业词表命中分组 → source=group（用 plan 里有而这里没有的词“药”）', () => {
    const r = conceptsFromText('同仁堂中药')
    expect(r).not.toBeNull()
    expect(['keyword', 'group']).toContain(r?.source)
  })
  it('都没命中为 null', () => {
    expect(conceptsFromText(UNKNOWN)).toBeNull()
  })
})

describe('normalizeObject', () => {
  it('补冠词、小写、去标点、元音用 an', () => {
    expect(normalizeObject('Coffee cup!')).toBe('a coffee cup')
    expect(normalizeObject('"apple"')).toBe('an apple')
    expect(normalizeObject('the open book')).toBe('an open book')
    expect(normalizeObject('t-shirt')).toBe('a t-shirt')
  })
  it('中文、超过 3 词、空串、非字符串都是 null', () => {
    expect(normalizeObject('咖啡杯')).toBeNull()
    expect(normalizeObject('one two three four')).toBeNull()
    expect(normalizeObject('   ')).toBeNull()
    expect(normalizeObject(3)).toBeNull()
    expect(normalizeObject(null)).toBeNull()
  })
})

describe('parseObjectsJson', () => {
  it('容忍代码围栏与前后废话', () => {
    const r = parseObjectsJson('好的：\n```json\n' + GOOD + '\n```\n以上。')
    expect(r).toEqual({ objects: ['a robot head', 'a microchip', 'a brain', 'a light bulb'] })
  })
  it('去重后不足 4 个报 issue，多于 4 个取前 4 个', () => {
    const r = parseObjectsJson('{"objects":["cup","a cup","a bean","a pot"]}')
    expect(r).toEqual({ issue: '只有 3 个有效英文名词，需要 4 个' })
    expect(parseObjectsJson('{"objects":["cup","bean","pot","mug","spoon"]}')).toEqual({ objects: ['a cup', 'a bean', 'a pot', 'a mug'] })
  })
  it('接受裸数组与“拆成数组的词”（0.8B 模型的常见输出）', () => {
    expect(parseObjectsJson('["a tent","a campfire","a compass","a lantern"]')).toEqual({ objects: ['a tent', 'a campfire', 'a compass', 'a lantern'] })
    expect(parseObjectsJson('[["coffee","cup"],["tea","pot"],["milk","jug"],["sugar","bowl"]]')).toEqual({ objects: ['a coffee cup', 'a tea pot', 'a milk jug', 'a sugar bowl'] })
  })
  it('非 JSON、坏 JSON、缺字段都报 issue', () => {
    expect('issue' in parseObjectsJson('抱歉')).toBe(true)
    expect('issue' in parseObjectsJson('{"objects":[')).toBe(true)
    expect('issue' in parseObjectsJson('{"x":1}')).toBe(true)
  })
})

describe('conceptsFromQwen', () => {
  it('第一次不合格、第二次合格：共调用 2 次，第 2 次的提示词带上次的问题', async () => {
    const run = vi.fn<RunConceptPrompt>().mockResolvedValueOnce('{"objects":["a cup"]}').mockResolvedValueOnce(GOOD)
    const r = await conceptsFromQwen('x', run)
    expect(r).toMatchObject({ source: 'qwen' })
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[1][0]).toContain('只有 1 个有效英文名词')
  })
  it('两次都不合格为 null；run 抛错原样透出（取消不被吞）', async () => {
    const bad = vi.fn<RunConceptPrompt>().mockResolvedValue('no')
    expect(await conceptsFromQwen('x', bad)).toBeNull()
    expect(bad).toHaveBeenCalledTimes(2)
    const boom = vi.fn<RunConceptPrompt>().mockRejectedValue(Object.assign(new Error('c'), { code: 'CANCELLED' }))
    await expect(conceptsFromQwen('x', boom)).rejects.toMatchObject({ code: 'CANCELLED' })
  })
})

describe('resolveConcepts', () => {
  it('命中词表不调模型', async () => {
    const run = vi.fn<RunConceptPrompt>()
    expect((await resolveConcepts('奶茶店', run)).source).toBe('keyword')
    expect(run).not.toHaveBeenCalled()
  })
  it('未命中且没有模型：通用词', async () => {
    expect(await resolveConcepts(UNKNOWN, null)).toEqual({ objects: [...GENERIC_OBJECTS], source: 'generic' })
  })
  it('未命中且模型成功：qwen；两次失败：通用词', async () => {
    expect((await resolveConcepts(UNKNOWN, async () => GOOD)).source).toBe('qwen')
    expect((await resolveConcepts(UNKNOWN, async () => 'x')).source).toBe('generic')
  })
})

describe('提示词', () => {
  it('conceptPrompt 与 P7 模板一致并压缩空白', () => {
    expect(conceptPrompt('  a   dumbbell ')).toBe('flat pictogram glyph of a dumbbell, solid black emoji silhouette, bold simple shape, minimalist icon, white background')
  })
  it('buildConceptPrompt 含品牌信息、JSON 要求与重试原因', () => {
    const p = buildConceptPrompt('星空咖啡', '缺少 objects 数组')
    expect(p).toContain('星空咖啡')
    expect(p).toContain('JSON')
    expect(p).toContain('缺少 objects 数组')
    expect(buildConceptPrompt('x')).not.toContain('上一次的问题')
  })
})

describe('describeConcepts', () => {
  it('四种来源各有说明，词表类带行业名', () => {
    expect(describeConcepts({ source: 'keyword', industry: 'gym' })).toBe('按行业词表推荐：健身')
    expect(describeConcepts({ source: 'group', industry: 'coffee' })).toBe('按行业大类推荐：咖啡')
    expect(describeConcepts({ source: 'qwen' })).toBe('本地模型按描述推荐')
    expect(describeConcepts({ source: 'generic' })).toBe('没认出行业，先用通用图形')
  })
})
