import { describe, expect, it } from 'vitest'
import { createMemoryStore } from './idb'

/** 测试记录 */
interface Rec {
  id: string
  ts: number
}

/** 新建带 ts 索引的内存仓库 */
const mkStore = () => createMemoryStore<Rec>([{ name: 'ts', keyPath: 'ts' }])

describe('createMemoryStore', () => {
  it('put / getAll 按主键升序', async () => {
    const s = mkStore()
    await s.put({ id: 'b', ts: 2 })
    await s.put({ id: 'a', ts: 1 })
    expect((await s.getAll()).map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('put 同 id 覆盖', async () => {
    const s = mkStore()
    await s.put({ id: 'a', ts: 1 })
    await s.put({ id: 'a', ts: 9 })
    expect(await s.getAll()).toEqual([{ id: 'a', ts: 9 }])
  })

  it('delete 与 clear，删不存在的不报错', async () => {
    const s = mkStore()
    await s.put({ id: 'a', ts: 1 })
    await s.put({ id: 'b', ts: 2 })
    await s.delete('a')
    await s.delete('nope')
    expect((await s.getAll()).map((r) => r.id)).toEqual(['b'])
    await s.clear()
    expect(await s.getAll()).toEqual([])
  })

  it('queryByIndex 闭区间并按索引升序', async () => {
    const s = mkStore()
    for (const [id, ts] of [['a', 30], ['b', 10], ['c', 20], ['d', 40]] as const) await s.put({ id, ts })
    expect((await s.queryByIndex('ts', 10, 30)).map((r) => r.id)).toEqual(['b', 'c', 'a'])
    expect((await s.queryByIndex('ts', 25)).map((r) => r.id)).toEqual(['a', 'd'])
    expect((await s.queryByIndex('ts', undefined, 10)).map((r) => r.id)).toEqual(['b'])
    expect(await s.queryByIndex('ts')).toHaveLength(4)
  })

  it('未知索引抛错', async () => {
    await expect(mkStore().queryByIndex('x')).rejects.toThrow('索引不存在')
  })

  it('返回的是拷贝，改它不影响库内数据', async () => {
    const s = mkStore()
    await s.put({ id: 'a', ts: 1 })
    const [r] = await s.getAll()
    r.ts = 99
    expect((await s.getAll())[0].ts).toBe(1)
  })
})
