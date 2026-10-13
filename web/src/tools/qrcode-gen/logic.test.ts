import { describe, expect, it } from 'vitest'
import { colorWarning, drawQr, layout, makeQr, parseHex, type DrawTarget, type QrMatrix } from './logic'

/** 记录绘制调用的假目标 */
function fakeTarget(): DrawTarget & { calls: Array<[string, number, number, number, number]> } {
  const calls: Array<[string, number, number, number, number]> = []
  const t = {
    fillStyle: '' as string,
    calls,
    fillRect(x: number, y: number, w: number, h: number) {
      calls.push([t.fillStyle, x, y, w, h])
    },
  }
  return t
}

describe('makeQr', () => {
  it('短文本落在 1 版 21x21，纠错等级保持用户选择', () => {
    const r = makeQr('Hello, world!', 'M')
    expect(r.ok && r.value.version).toBe(1)
    expect(r.ok && r.value.size).toBe(21)
    expect(r.ok && r.value.ecc).toBe('M')
  })

  it('纠错越高版本越大：13 字节在 Q 级需要 2 版 25x25', () => {
    const r = makeQr('Hello, world!', 'Q')
    expect(r.ok && r.value.version).toBe(2)
    expect(r.ok && r.value.size).toBe(25)
  })

  it('尺寸公式 size = 17 + 4 * version，矩阵为方阵', () => {
    const r = makeQr('https://example.com/some/long/path?x=1&y=2', 'L')
    if (!r.ok) throw new Error('应成功')
    expect(r.value.size).toBe(17 + 4 * r.value.version)
    expect(r.value.modules).toHaveLength(r.value.size)
    expect(r.value.modules.every((row) => row.length === r.value.size)).toBe(true)
  })

  it('左上角是 7x7 定位图案：外圈深、内圈浅、中心深', () => {
    const r = makeQr('a', 'L')
    if (!r.ok) throw new Error('应成功')
    const m = r.value.modules
    expect(m[0].slice(0, 7).every(Boolean)).toBe(true)
    expect(m[1][1]).toBe(false)
    expect(m[3][3]).toBe(true)
    expect(m[0][7]).toBe(false)
  })

  it('支持中文（UTF-8）', () => {
    expect(makeQr('你好，世界', 'M').ok).toBe(true)
  })

  it('空内容与超容量都给中文错误', () => {
    const empty = makeQr('', 'L')
    expect(!empty.ok && empty.error).toContain('请输入')
    const big = makeQr('a'.repeat(3000), 'L')
    expect(!big.ok && big.error).toContain('太长')
  })

  it('40 版 L 级可装 2953 字节，多 1 字节就超限', () => {
    expect(makeQr('a'.repeat(2953), 'L').ok).toBe(true)
    expect(makeQr('a'.repeat(2954), 'L').ok).toBe(false)
  })
})

describe('layout / drawQr', () => {
  const qr: QrMatrix = {
    size: 2,
    version: 1,
    ecc: 'L',
    modules: [
      [true, false],
      [false, true],
    ],
  }

  it('整数缩放，不超过目标尺寸，太小时至少 1 像素', () => {
    expect(layout(21, { size: 256, border: 4, fg: '', bg: '' })).toEqual({ scale: 8, pixels: 232 })
    expect(layout(21, { size: 10, border: 4, fg: '', bg: '' })).toEqual({ scale: 1, pixels: 29 })
  })

  it('先画背景再画深色模块，坐标含边距', () => {
    const t = fakeTarget()
    const px = drawQr(t, qr, { size: 60, border: 1, fg: '#111111', bg: '#eeeeee' })
    expect(px).toBe(60)
    expect(t.calls[0]).toEqual(['#eeeeee', 0, 0, 60, 60])
    expect(t.calls.slice(1)).toEqual([
      ['#111111', 15, 15, 15, 15],
      ['#111111', 30, 30, 15, 15],
    ])
  })
})

describe('颜色', () => {
  it('解析 hex', () => {
    expect(parseHex('#fff')).toEqual([255, 255, 255])
    expect(parseHex('#0a0B0c')).toEqual([10, 11, 12])
    expect(parseHex('red')).toBeNull()
  })

  it('对比度与反色提示', () => {
    expect(colorWarning('#000000', '#ffffff')).toBe('')
    expect(colorWarning('#cccccc', '#ffffff')).toContain('对比度')
    expect(colorWarning('#ffffff', '#000000')).toContain('反色')
    expect(colorWarning('bad', '#fff')).toBe('')
  })
})
