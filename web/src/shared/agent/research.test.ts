import { describe, expect, it, vi } from 'vitest'

/** 带空 window 加载模块（原生桥模块加载时要读 window） */
async function load() {
  vi.stubGlobal('window', {})
  return import('./research')
}

describe('parseSubQueries', () => {
  it('清理序号与符号、去重、限个数', async () => {
    const { parseSubQueries } = await load()
    const raw = '1. 量子计算\n- “量子计算”\n2) 量子 通信\n3、量子 密码\n4. 量子 传感'
    expect(parseSubQueries(raw, '原问题', 3)).toEqual(['量子计算', '量子 通信', '量子 密码'])
  })

  it('丢掉过短过长的行，全无效时退回原问题', async () => {
    const { parseSubQueries } = await load()
    expect(parseSubQueries('a\n' + 'x'.repeat(50), ' 原问题 ', 3)).toEqual(['原问题'])
    expect(parseSubQueries('', '原问题', 3)).toEqual(['原问题'])
  })
})

describe('selectPassage', () => {
  it('短文本原样返回', async () => {
    const { selectPassage } = await load()
    expect(selectPassage('一句话。', '话', 100)).toBe('一句话。')
  })

  it('优先挑含关键词的句子，且保持原顺序、不超上限', async () => {
    const { selectPassage } = await load()
    const text = '天气很好。量子计算利用叠加态。今天吃饭。量子比特是基本单位。'
    const out = selectPassage(text, '量子', 20)
    expect(out).toBe('量子计算利用叠加态。量子比特是基本单位。')
    expect(out.length).toBeLessThanOrEqual(20)
  })

  it('没有任何重合时取开头', async () => {
    const { selectPassage } = await load()
    expect(selectPassage('甲乙丙丁戊己庚辛', 'zzz', 4)).toBe('甲乙丙丁')
  })
})

describe('mergeHits', () => {
  it('按网址去重并轮流各取一条', async () => {
    const { mergeHits } = await load()
    const h = (u: string) => ({ title: u, url: u, text: u })
    const out = mergeHits([[h('a'), h('b')], [h('a'), h('c')]], 3)
    expect(out.map((x) => x.url)).toEqual(['a', 'b', 'c'])
  })
})

describe('runResearch', () => {
  /** 造依赖：第一次 generate 返回拆题结果，第二次返回回答 */
  function deps(plan: string, answer: string, hits: { title: string; url: string; text: string }[]) {
    const generate = vi.fn().mockResolvedValueOnce(plan).mockResolvedValueOnce(answer)
    const search = vi.fn().mockResolvedValue(hits)
    return { generate, search }
  }

  it('拆问题 → 搜索 → 带资料回答', async () => {
    const { runResearch } = await load()
    const d = deps('量子计算\n量子 应用', ' 答案[1] ', [{ title: '量子计算机', url: 'u1', text: '量子计算机是……' }])
    const events: string[] = []
    const r = await runResearch('量子计算有什么用', d, (e) => events.push(e.stage))
    expect(r.queries).toEqual(['量子计算', '量子 应用'])
    expect(r.sources).toHaveLength(1)
    expect(r.answer).toBe('答案[1]')
    expect(events).toEqual(['plan', 'search', 'answer'])
    expect(d.generate.mock.calls[1][1]).toContain('[1] 量子计算机')
    expect(d.generate.mock.calls[1][1]).toContain('【问题】量子计算有什么用')
  })

  it('没搜到资料时不再调模型', async () => {
    const { runResearch, NO_RESULT_ANSWER } = await load()
    const d = deps('关键词', 'unused', [])
    const r = await runResearch('问题', d)
    expect(r.answer).toBe(NO_RESULT_ANSWER)
    expect(d.generate).toHaveBeenCalledTimes(1)
  })

  it('单个搜索失败不影响其它子问题', async () => {
    const { runResearch } = await load()
    const generate = vi.fn().mockResolvedValueOnce('甲甲\n乙乙').mockResolvedValueOnce('答')
    const search = vi.fn().mockRejectedValueOnce(new Error('net')).mockResolvedValueOnce([{ title: 't', url: 'u', text: 'x' }])
    const r = await runResearch('问', { generate, search })
    expect(r.sources).toHaveLength(1)
  })

  it('取消后抛出，不会继续调模型', async () => {
    const { runResearch } = await load()
    const ac = new AbortController()
    const generate = vi.fn().mockResolvedValue('甲甲')
    const search = vi.fn().mockImplementation(async () => {
      ac.abort()
      return [{ title: 't', url: 'u', text: 'x' }]
    })
    await expect(runResearch('问', { generate, search }, undefined, ac.signal)).rejects.toThrow()
    expect(generate).toHaveBeenCalledTimes(1)
  })
})
