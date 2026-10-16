import { describe, expect, it, vi } from 'vitest'
import {
  BANNER_MAX,
  BANNER_MIN,
  buildPrompt,
  CATEGORY_HINTS,
  DEFAULT_CATEGORY,
  generateCouplet,
  hanCount,
  MAX_ATTEMPTS,
  parseReply,
  buildUpperPrompt,
  generateUpper,
  validateUpperReply,
  UPPER_LEN_ANY,
  validateReply,
  validateUpper,
  type LlmRequest,
} from './generate'

/** 基础请求：要 4 字横批 */
const REQ: LlmRequest = { demand: '程序员加班', wantBanner: true, bannerLen: 4, category: '事业' }
/** 不要横批的请求 */
const NO_BANNER: LlmRequest = { ...REQ, wantBanner: false }

describe('类型表', () => {
  it('通用排第一；类型名不认识时按通用写', () => {
    expect(CATEGORY_HINTS[0].name).toBe(DEFAULT_CATEGORY)
    expect(buildPrompt({ ...REQ, category: '不存在的类型' })).toBe(buildPrompt({ ...REQ, category: DEFAULT_CATEGORY }))
  })
  it('16 类，含挽联，名字不重复', () => {
    expect(CATEGORY_HINTS).toHaveLength(16)
    expect(new Set(CATEGORY_HINTS.map((c) => c.name)).size).toBe(16)
    expect(CATEGORY_HINTS.some((c) => c.name === '挽联')).toBe(true)
  })
  it('横批字数范围 2~7', () => {
    expect([BANNER_MIN, BANNER_MAX]).toEqual([2, 7])
  })
})

describe('buildPrompt', () => {
  it('带上要求、类型与横批字数', () => {
    const p = buildPrompt(REQ)
    expect(p).toContain('程序员加班')
    expect(p).toContain('事业')
    expect(p).toContain('横批：……（正好 4 个汉字）')
  })
  it('不要横批时明说不要写', () => {
    const p = buildPrompt(NO_BANNER)
    expect(p).not.toContain('横批：')
    expect(p).toContain('不要写横批')
  })
  it('要求留空走自由发挥；未知类型回落通用；重试带上次原因', () => {
    expect(buildPrompt({ ...REQ, demand: '  ' })).toContain('自由发挥')
    expect(buildPrompt({ ...REQ, category: '不存在' })).toContain('类型：通用')
    expect(buildPrompt(REQ, '字数不相等')).toContain('上一次的问题：字数不相等')
  })
  it('挽联提示庄重', () => {
    expect(buildPrompt({ ...REQ, category: '挽联' })).toContain('庄重')
  })
})

describe('parseReply', () => {
  it('标准三行', () => {
    expect(parseReply('上联：春风送暖\n下联：瑞雪兆丰\n横批：万象更新')).toEqual({ up: '春风送暖', down: '瑞雪兆丰', banner: '万象更新' })
  })
  it('容忍星号、序号、引号、半角冒号与尾句号', () => {
    const t = '好的：\n1. **上联**：「春风送暖」。\n- 下联: "瑞雪兆丰"\n横批：《万象更新》'
    expect(parseReply(t)).toEqual({ up: '春风送暖', down: '瑞雪兆丰', banner: '万象更新' })
  })
  it('缺项为空串，重复项取第一个', () => {
    expect(parseReply('上联：甲乙\n上联：丙丁')).toEqual({ up: '甲乙', down: '', banner: '' })
    expect(parseReply('随便聊聊')).toEqual({ up: '', down: '', banner: '' })
  })
})

describe('validateReply', () => {
  const ok = { up: '春风送暖', down: '瑞雪兆丰', banner: '万象更新' }
  it('合格', () => {
    expect(validateReply(ok, REQ)).toBeNull()
    expect(validateReply({ ...ok, banner: '' }, NO_BANNER)).toBeNull()
  })
  it('缺联、字数不等、断句不一致、两联相同', () => {
    expect(validateReply({ ...ok, down: '' }, REQ)).toContain('同时')
    expect(validateReply({ ...ok, down: '瑞雪兆丰年' }, REQ)).toContain('不相等')
    expect(validateReply({ up: '春风，送暖', down: '瑞雪兆，丰', banner: '万象更新' }, REQ)).toContain('断句')
    expect(validateReply({ up: '春风送暖', down: '春风送暖', banner: '万象更新' }, REQ)).toContain('一样')
  })
  it('含字母数字与括号的判不合格', () => {
    expect(validateReply({ ...ok, up: '春风AB' }, REQ)).toContain('字符')
    expect(validateReply({ ...ok, down: '瑞雪(兆)丰' }, REQ)).toContain('字符')
  })
  it('字数过短或过长', () => {
    expect(validateReply({ up: '春', down: '夏', banner: '万象更新' }, REQ)).toContain('字数')
    expect(validateReply({ up: '春'.repeat(21), down: '夏'.repeat(21), banner: '万象更新' }, REQ)).toContain('字数')
  })
  it('横批：缺、字数不符、含非汉字，2 到 7 字都能过', () => {
    expect(validateReply({ ...ok, banner: '' }, REQ)).toContain('没有写横批')
    expect(validateReply({ ...ok, banner: '万象' }, REQ)).toContain('要求 4 字')
    expect(validateReply({ ...ok, banner: '万象，新' }, REQ)).toContain('字符')
    expect(validateReply({ ...ok, banner: '万象更新' }, { ...REQ, bannerLen: 7 })).toContain('要求 7 字')
    for (let n = BANNER_MIN; n <= BANNER_MAX; n++) {
      expect(validateReply({ ...ok, banner: '甲'.repeat(n) }, { ...REQ, bannerLen: n })).toBeNull()
    }
  })
  it('hanCount 不数标点', () => {
    expect(hanCount('春风，送暖。')).toBe(4)
  })
})

describe('generateCouplet', () => {
  const good = '上联：春风送暖\n下联：瑞雪兆丰\n横批：万象更新'
  const bad = '上联：春风送暖入屠苏\n下联：瑞雪兆丰\n横批：万象更新'

  it('一次合格直接返回', async () => {
    const run = vi.fn().mockResolvedValue(good)
    const r = await generateCouplet(REQ, run)
    expect(r).toEqual({ ok: true, couplet: { up: '春风送暖', down: '瑞雪兆丰', banner: '万象更新' }, attempts: 1 })
    expect(run).toHaveBeenCalledTimes(1)
  })
  it('第一次不合格，带着原因重试一次，第二次合格', async () => {
    const run = vi.fn().mockResolvedValueOnce(bad).mockResolvedValueOnce(good)
    const r = await generateCouplet(REQ, run)
    expect(r.ok).toBe(true)
    expect(r.attempts).toBe(2)
    expect(run.mock.calls[1][0]).toContain('上一次的问题')
    expect(run.mock.calls[1][1]).toBe(2)
  })
  it('连续不合格：最多尝试 MAX_ATTEMPTS 次，给原因与原文', async () => {
    const run = vi.fn().mockResolvedValue(bad)
    const r = await generateCouplet(REQ, run)
    expect(run).toHaveBeenCalledTimes(MAX_ATTEMPTS)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain('不相等')
      expect(r.raw).toBe(bad)
    }
  })
  it('不要横批时丢弃模型多写的横批', async () => {
    const r = await generateCouplet(NO_BANNER, async () => good)
    expect(r.ok && r.couplet.banner).toBe('')
  })
  it('模型调用抛错直接向上抛，不重试', async () => {
    const run = vi.fn().mockRejectedValue(new Error('NOT_READY'))
    await expect(generateCouplet(REQ, run)).rejects.toThrow('NOT_READY')
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('validateUpper', () => {
  it('合格与各种不合格', () => {
    expect(validateUpper('春风送暖入屠苏')).toBeNull()
    expect(validateUpper('春风，送暖')).toBeNull()
    expect(validateUpper('  ')).toContain('请先')
    expect(validateUpper('春'.repeat(15))).toContain('14')
    expect(validateUpper('春风abc')).toContain('只能')
    expect(validateUpper('，，')).toContain('汉字')
    expect(validateUpper('春'.repeat(10), 8)).toContain('8')
  })
})

describe('出上联', () => {
  it('提示词：带字数与类型，且不让写下联', () => {
    const p = buildUpperPrompt({ demand: '', category: '春节', len: 7 })
    expect(p).toContain('正好 7 个汉字')
    expect(p).toContain('春节')
    expect(p).toContain('不要写下联')
    expect(buildUpperPrompt({ demand: '', category: '春节', len: UPPER_LEN_ANY })).not.toContain('正好')
  })
  it('校验：字数、字符', () => {
    expect(validateUpperReply('春风送暖入屠苏', 7)).toBeNull()
    expect(validateUpperReply('春风送暖', 7)).toContain('要求 7 字')
    expect(validateUpperReply('春风abc', UPPER_LEN_ANY)).toContain('之外')
    expect(validateUpperReply('', UPPER_LEN_ANY)).toContain('没有')
  })
  it('生成：首次不合格会带原因重试', async () => {
    const run = vi.fn().mockResolvedValueOnce('上联：春风').mockResolvedValueOnce('上联：春风送暖入屠苏')
    const r = await generateUpper({ demand: '', category: '通用', len: 7 }, run)
    expect(r).toEqual({ ok: true, up: '春风送暖入屠苏', attempts: 2 })
    expect(run.mock.calls[1][0]).toContain('上一次的问题')
  })
  it('生成：没写“上联：”时取第一行', async () => {
    const r = await generateUpper({ demand: '', category: '通用', len: UPPER_LEN_ANY }, async () => '\n春风送暖\n')
    expect(r.ok && r.up).toBe('春风送暖')
  })
  it('生成：两次都不合格返回失败', async () => {
    const r = await generateUpper({ demand: '', category: '通用', len: 7 }, async () => '上联：春风')
    expect(r.ok).toBe(false)
  })
})
