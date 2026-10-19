import { describe, expect, it } from 'vitest'
import {
  CODE128_PATTERNS,
  CODE39_WIDE,
  drawBarcode,
  eanCheckDigit,
  encodeBarcode,
  encodeCode128,
  encodeCode39,
  encodeEan13,
  layoutBarcode,
  QUIET_MODULES,
  type DrawOptions,
} from './logic'

const opts: DrawOptions = { scale: 2, barHeight: 100, showText: true, fg: '#000', bg: '#fff' }

/** 取成功的模块串 */
function mods(r: ReturnType<typeof encodeEan13>): string {
  if (!r.ok) throw new Error(r.error)
  return r.modules
}

describe('EAN-13', () => {
  it('校验位', () => {
    expect(eanCheckDigit('590123412345')).toBe(7)
    expect(eanCheckDigit('400638133393')).toBe(1)
  })
  it('12 位自动补，95 个模块，护线正确', () => {
    const r = encodeEan13('590123412345')
    expect(r.ok && r.label).toBe('5901234123457')
    const m = mods(r)
    expect(m).toHaveLength(95)
    expect(m.slice(0, 3)).toBe('101')
    expect(m.slice(45, 50)).toBe('01010')
    expect(m.slice(92)).toBe('101')
  })
  it('已知条码：4006381333931 左半用 LGGLLG（首位 4 对应 LGLLGG）', () => {
    const m = mods(encodeEan13('4006381333931'))
    // 首位 4：左 6 位 L G L L G G，第 1 位数字 0 用 L 码 0001101
    expect(m.slice(3, 10)).toBe('0001101')
    // 第 2 位数字 0 用 G 码 0100111
    expect(m.slice(10, 17)).toBe('0100111')
    // 右侧最后一位 1 的 R 码 1100110
    expect(m.slice(85, 92)).toBe('1100110')
  })
  it('13 位校验失败与输入错误', () => {
    const bad = encodeEan13('5901234123450')
    expect(!bad.ok && bad.error).toContain('应为 7')
    expect(encodeEan13('12345').ok).toBe(false)
    expect(encodeEan13('12a').ok).toBe(false)
    expect(encodeEan13('').ok).toBe(false)
  })
})

describe('Code128 B', () => {
  it('符号表：每个 6 位和为 11，无重复，共 106 个', () => {
    expect(CODE128_PATTERNS).toHaveLength(106)
    expect(new Set(CODE128_PATTERNS).size).toBe(106)
    for (const p of CODE128_PATTERNS) expect([...p].reduce((s, c) => s + Number(c), 0)).toBe(11)
  })
  it('单字符 A：起始 B + 符号 33 + 校验 34 + 终止，共 11*3+13 个模块', () => {
    const r = encodeCode128('A')
    expect(r.ok && r.modules).toHaveLength(11 * 3 + 13)
    // 起始符 B = 211214 → 11 0 11 0 0 0 0 1 0 0 0 ... 取前 11 位
    expect(r.ok && r.modules.slice(0, 11)).toBe('11010010000')
    // 校验 (104+33)%103=34，符号 34 = 131123
    expect(r.ok && r.modules.slice(22, 33)).toBe('10001011000')
    expect(r.ok && r.modules.endsWith('1100011101011')).toBe(true)
  })
  it('长度随字符数线性增长', () => {
    const a = encodeCode128('abc')
    expect(a.ok && a.modules.length).toBe(11 * (1 + 3 + 1) + 13)
  })
  it('非 ASCII 或空', () => {
    const r = encodeCode128('中')
    expect(!r.ok && r.error).toContain('中')
    expect(encodeCode128('').ok).toBe(false)
    expect(encodeCode128('a\n').ok).toBe(false)
  })
})

describe('Code39', () => {
  it('每个字符 3 个宽元素且互不相同', () => {
    const keys = Object.keys(CODE39_WIDE)
    expect(keys).toHaveLength(44)
    expect(new Set(keys.map((k) => CODE39_WIDE[k].join())).size).toBe(44)
    for (const k of keys) expect(CODE39_WIDE[k]).toHaveLength(3)
  })
  it('字符 * 的模式 nwnnwnwnn，模块宽 12（6 窄 + 3 宽 => 6+9）', () => {
    const r = encodeCode39('A')
    // * 的模块串：n w n n w n w n n → 1 000 1 0 111 0 111 0 1 ... 总宽 6*1+3*3=15
    expect(r.ok && r.modules).toHaveLength(15 * 3 + 2)
    expect(r.ok && r.modules.slice(0, 15)).toBe('100010111011101')
  })
  it('小写转大写，label 为大写', () => {
    const r = encodeCode39('ab-1')
    expect(r.ok && r.label).toBe('AB-1')
  })
  it('不支持字符与 *', () => {
    expect(encodeCode39('a_b').ok).toBe(false)
    expect(encodeCode39('A*B').ok).toBe(false)
    expect(encodeCode39('').ok).toBe(false)
  })
})

describe('encodeBarcode 与绘制', () => {
  it('按类型分发', () => {
    expect(encodeBarcode('ean13', '590123412345').ok).toBe(true)
    expect(encodeBarcode('code128', 'x').ok).toBe(true)
    expect(encodeBarcode('code39', 'x').ok).toBe(true)
  })
  it('尺寸计算', () => {
    expect(layoutBarcode(95, opts)).toEqual({ width: (95 + QUIET_MODULES * 2) * 2, height: 100 + 28 + QUIET_MODULES })
  })
  it('画条：相邻黑模块合并成一个矩形，宽度按 scale', () => {
    const rects: number[][] = []
    const ctx = {
      fillStyle: '',
      fillRect: (...a: number[]) => rects.push(a),
      fillText: () => {},
    }
    drawBarcode(ctx, { modules: '1101', label: 'x' }, { ...opts, showText: false })
    // 第 0 个是背景，其后是 "11" 与 "1"
    expect(rects).toHaveLength(3)
    expect(rects[1]).toEqual([QUIET_MODULES * 2, 5, 4, 100])
    expect(rects[2]).toEqual([(QUIET_MODULES + 3) * 2, 5, 2, 100])
  })
})
