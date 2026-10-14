import { describe, expect, it, vi } from 'vitest'
import { copyWithFallback, FILE_CHUNK_BYTES, formatHex, hashBytes, hashFile, hashText, matchExpected } from './logic'

/** 空串向量 */
const EMPTY = {
  md5: 'd41d8cd98f00b204e9800998ecf8427e',
  sha1: 'da39a3ee5e6b4b0d3255bfef95601890afd80709',
  sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  sha512:
    'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e',
}

describe('hashText', () => {
  it('空串', () => {
    expect(hashText('')).toEqual(EMPTY)
  })

  it('abc 标准向量', () => {
    const d = hashText('abc')
    expect(d.md5).toBe('900150983cd24fb0d6963f7d28e17f72')
    expect(d.sha1).toBe('a9993e364706816aba3e25717850c26c9cd0d89d')
    expect(d.sha256).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(d.sha512.startsWith('ddaf35a193617abacc417349ae204131')).toBe(true)
  })

  it('quick brown fox', () => {
    const d = hashText('The quick brown fox jumps over the lazy dog')
    expect(d.md5).toBe('9e107d9d372bb6826bd81d3542a419d6')
    expect(d.sha1).toBe('2fd4e1c67a2d28fced849ee1bb76e7391b93eb12')
    expect(d.sha256).toBe('d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592')
  })

  it('中文按 UTF-8', () => {
    // "你好" 的 UTF-8 为 e4 bd a0 e5 a5 bd
    expect(hashText('你好').md5).toBe('7eca689f0d3389d9dea66ae112e5cfd7')
    expect(hashText('你好')).toEqual(hashBytes(new Uint8Array([0xe4, 0xbd, 0xa0, 0xe5, 0xa5, 0xbd])))
  })
})

describe('hashFile', () => {
  it('分块结果与一次性计算一致，并回报进度', async () => {
    const bytes = new Uint8Array(10_000).map((_, i) => i % 251)
    const progress: number[] = []
    const d = await hashFile(new Blob([bytes]), { chunkBytes: 3000, onProgress: (done) => progress.push(done) })
    expect(d).toEqual(hashBytes(bytes))
    expect(progress).toEqual([3000, 6000, 9000, 10000])
  })

  it('空文件等于空串哈希', async () => {
    expect(await hashFile(new Blob([]))).toEqual(EMPTY)
  })

  it('取消返回 null', async () => {
    expect(await hashFile(new Blob([new Uint8Array(10)]), { chunkBytes: 4, isCancelled: () => true })).toBeNull()
  })

  it('默认分块大小为 2MB', () => {
    expect(FILE_CHUNK_BYTES).toBe(2097152)
  })
})

describe('formatHex / matchExpected', () => {
  it('大小写切换', () => {
    expect(formatHex('ab12', true)).toBe('AB12')
    expect(formatHex('ab12', false)).toBe('ab12')
  })

  it('期望值比对忽略大小写与空白', () => {
    const d = hashText('abc')
    expect(matchExpected(d, ' 900150983CD24FB0D6963F7D28E17F72\n')).toBe('md5')
    expect(matchExpected(d, 'a9993e364706816aba3e25717850c26c9cd0d89d')).toBe('sha1')
    expect(matchExpected(d, 'deadbeef')).toBeNull()
    expect(matchExpected(d, '  ')).toBeNull()
  })
})

describe('copyWithFallback', () => {
  it('首选成功就不走回退', async () => {
    const fb = vi.fn(async () => true)
    expect(await copyWithFallback('a', async () => true, fb)).toBe(true)
    expect(fb).not.toHaveBeenCalled()
  })
  it('首选返回 false 或抛错时回退', async () => {
    const fb = vi.fn(async () => true)
    expect(await copyWithFallback('a', async () => false, fb)).toBe(true)
    expect(await copyWithFallback('b', async () => Promise.reject(new Error('x')), fb)).toBe(true)
    expect(fb).toHaveBeenCalledTimes(2)
    expect(fb).toHaveBeenLastCalledWith('b')
  })
  it('回退也失败则为 false', async () => {
    expect(await copyWithFallback('a', async () => false, async () => false)).toBe(false)
  })
})
