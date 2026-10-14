import { describe, expect, it } from 'vitest'
import {
  colorWarning,
  drawQr,
  fitContain,
  layout,
  logoAdvice,
  logoHit,
  logoMaxModules,
  logoRects,
  LONG_TEXT_CHARS,
  makeQr,
  parseHex,
  resolveLogo,
  type DrawTarget,
  type QrMatrix,
} from './logic'

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

describe('logo 辅助', () => {
  it('fitContain 保持比例并居中', () => {
    const r = fitContain(200, 100, { x: 0, y: 0, w: 100, h: 100 })
    expect(r).toEqual({ x: 0, y: 25, w: 100, h: 50 })
  })
  it('fitContain 非法尺寸返回方框', () => {
    const b = { x: 1, y: 2, w: 3, h: 3 }
    expect(fitContain(0, 10, b)).toBe(b)
  })
})

/** 调研参考表：版本 → [L, M, Q, H] 的安全模块数（w/t ≤ 0.5，奇数） */
const REF_MAX: Array<[number, [number, number, number, number]]> = [
  [2, [1, 3, 3, 5]],
  [4, [3, 5, 7, 7]],
  [5, [3, 7, 9, 9]],
  [7, [7, 7, 11, 11]],
  [10, [9, 13, 15, 17]],
]

describe('logoMaxModules 与调研参考表一致', () => {
  for (const [v, row] of REF_MAX) {
    it(`版本 ${v}`, () => {
      const got = (['L', 'M', 'Q', 'H'] as const).map((e) => logoMaxModules(v, e))
      expect(got).toEqual(row)
    })
  }
  it('结果恒为奇数且随纠错等级不降', () => {
    for (let v = 1; v <= 40; v++) {
      const row = (['L', 'M', 'Q', 'H'] as const).map((e) => logoMaxModules(v, e))
      row.forEach((k) => expect(k === 0 || k % 2 === 1).toBe(true))
      expect(row[3]).toBeGreaterThanOrEqual(row[0])
    }
  })
  it('logoHit 码字总数自洽：全盖时最差块数不超过块内码字数', () => {
    const h = logoHit(1, 'L', 1)
    expect(h.limit).toBe(3)
    expect(h.worst).toBe(1)
  })
})

describe('resolveLogo', () => {
  it('模块数为奇数，占比按码边长（不含静区）', () => {
    const p = resolveLogo(10, 57, 'H', 20)
    expect(p.modules % 2).toBe(1)
    expect(p.modules).toBe(11)
    expect(p.pct).toBe(19)
  })
  it('超限自动缩小到安全上限并标记 shrunk', () => {
    const p = resolveLogo(4, 33, 'M', 30)
    expect(p.maxModules).toBe(5)
    expect(p.modules).toBe(5)
    expect(p.shrunk).toBe(true)
    expect(p.unfit).toBe(false)
  })
  it('滑块拉满不算缩小，且能到达上限模块数', () => {
    const p = resolveLogo(4, 33, 'Q', 100)
    const atMax = resolveLogo(4, 33, 'Q', p.maxPct)
    expect(atMax.shrunk).toBe(false)
    expect(atMax.modules).toBe(p.maxModules)
  })
  it('版本 2 的 L 级上限只有 1 格，判为不适合', () => {
    const p = resolveLogo(2, 25, 'L', 20)
    expect(p.maxModules).toBe(1)
    expect(p.unfit).toBe(true)
  })
})

describe('logoRects', () => {
  it('底板对齐模块网格、居中、整格覆盖', () => {
    const { plate, inner } = logoRects(33, 4, 8, 7)
    expect(plate).toEqual({ x: 136, y: 136, w: 56, h: 56 })
    expect(plate.x % 8).toBe(0)
    expect(plate.x * 2 + plate.w).toBe((33 + 8) * 8)
    expect(inner).toEqual({ x: 144, y: 144, w: 40, h: 40 })
  })
  it('小底板不留白', () => {
    const { plate, inner } = logoRects(25, 0, 10, 3)
    expect(inner).toEqual(plate)
  })
})

describe('logoAdvice', () => {
  const ok = resolveLogo(4, 33, 'H', 10)
  it('L/M 提示成功率降低并给 Q、H 升级项', () => {
    for (const e of ['L', 'M'] as const) {
      const a = logoAdvice(e, 20, resolveLogo(4, 33, e, 10))
      expect(a.eccWarning).toContain('扫码成功率会明显降低')
      expect(a.upgrade).toEqual(['Q', 'H'])
    }
  })
  it('Q/H 且内容不长时无提示', () => {
    expect(logoAdvice('Q', 20, resolveLogo(4, 33, 'Q', 10))).toMatchObject({ eccWarning: '', upgrade: [], longNote: '' })
    expect(logoAdvice('H', 20, ok).upgrade).toEqual([])
  })
  it('长内容阈值：恰好等于不触发，超过触发；Q 级建议升 H，H 级不再建议', () => {
    expect(logoAdvice('Q', LONG_TEXT_CHARS, ok).longNote).toBe('')
    const q = logoAdvice('Q', LONG_TEXT_CHARS + 1, ok)
    expect(q.longNote).toContain('短链')
    expect(q.upgrade).toEqual(['H'])
    expect(logoAdvice('H', LONG_TEXT_CHARS + 1, ok).upgrade).toEqual([])
  })
  it('缩小与不适合提示的触发条件', () => {
    const shrunk = logoAdvice('M', 20, resolveLogo(4, 33, 'M', 30))
    expect(shrunk.shrinkNote).toBe('已缩小到 15%，建议改用 Q/H 或缩短内容')
    expect(logoAdvice('H', 20, ok).shrinkNote).toBe('')
    const unfit = logoAdvice('L', 20, resolveLogo(2, 25, 'L', 20))
    expect(unfit.unfitNote).toContain('不适合')
    expect(unfit.shrinkNote).toBe('')
  })
})
