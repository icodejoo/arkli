import { describe, expect, it, vi } from 'vitest'
import type { CorpusCouplet } from '@/native/corpus'
import { QUIZ_MAX_DRAWS, drawByLength } from './quiz'
import { UPPER_LEN_ANY } from './generate'

/** 造一副对联：上联取给定文字 */
function cp(up: string): CorpusCouplet {
  return { id: 0, up, down: '下', banner: '', cats: [], primary: '' }
}

describe('drawByLength', () => {
  it('不限字数：第一副就返回', async () => {
    const get = vi.fn(async () => cp('春风送暖'))
    const d = await drawByLength(null, 10, 10, UPPER_LEN_ANY, get)
    expect(d?.couplet.up).toBe('春风送暖')
    expect(get).toHaveBeenCalledTimes(1)
  })
  it('限字数：跳过不合的，游标随之前进', async () => {
    const ups = ['春风', '春风送暖', '春风送暖入屠苏']
    let i = 0
    const get = vi.fn(async () => cp(ups[i++ % ups.length]))
    const d = await drawByLength(null, 10, 10, 7, get)
    expect(d?.couplet.up).toBe('春风送暖入屠苏')
    expect(d?.cursor.k).toBe(3)
  })
  it('标点不计字数', async () => {
    const d = await drawByLength(null, 10, 10, 6, async () => cp('春风，送暖，'))
    expect(d).toBeNull()
    const ok = await drawByLength(null, 10, 10, 4, async () => cp('春风，送暖，'))
    expect(ok).not.toBeNull()
  })
  it('一直抽不到就放弃', async () => {
    const get = vi.fn(async () => cp('春风'))
    expect(await drawByLength(null, 1000, 1000, 9, get)).toBeNull()
    expect(get).toHaveBeenCalledTimes(QUIZ_MAX_DRAWS)
  })
  it('池为空返回 null', async () => {
    expect(await drawByLength(null, 0, 0, UPPER_LEN_ANY, async () => cp('春风'))).toBeNull()
  })
})
