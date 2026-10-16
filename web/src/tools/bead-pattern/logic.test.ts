import { describe, expect, it } from 'vitest'
import { GENERIC_PALETTE, PALETTES, type Palette } from './data'
import {
  buildLabPalette,
  chooseCell,
  clampGrid,
  contrastColor,
  cropSquare,
  downsample,
  GRID_MAX,
  GRID_MIN,
  hexToRgb,
  legendLayout,
  mapToPalette,
  nearestIndex,
  patternLayout,
  srgbToLab,
  usageStats,
  percentText,
  usageText,
  validatePalette,
} from './logic'

/** 三色小调色板 */
const tiny: Palette = {
  id: 't',
  name: 't',
  colors: [
    { code: 'T1', name: '黑', hex: '#000000' },
    { code: 'T2', name: '白', hex: '#ffffff' },
    { code: 'T3', name: '红', hex: '#ff0000' },
  ],
}

describe('hexToRgb', () => {
  it('解析带或不带 # 的色值', () => {
    expect(hexToRgb('#ff8000')).toEqual([255, 128, 0])
    expect(hexToRgb('00ff7f')).toEqual([0, 255, 127])
  })
  it('非法输入返回黑', () => {
    expect(hexToRgb('red')).toEqual([0, 0, 0])
  })
})

describe('srgbToLab', () => {
  it('白、黑', () => {
    const w = srgbToLab(255, 255, 255)
    expect(w[0]).toBeCloseTo(100, 1)
    expect(w[1]).toBeCloseTo(0, 1)
    expect(w[2]).toBeCloseTo(0, 1)
    expect(srgbToLab(0, 0, 0)[0]).toBeCloseTo(0, 5)
  })
  it('纯红的已知 Lab 值', () => {
    const [l, a, b] = srgbToLab(255, 0, 0)
    expect(l).toBeCloseTo(53.24, 1)
    expect(a).toBeCloseTo(80.09, 1)
    expect(b).toBeCloseTo(67.2, 1)
  })
  it('灰色 a、b 接近 0', () => {
    const [, a, b] = srgbToLab(128, 128, 128)
    expect(Math.abs(a)).toBeLessThan(0.1)
    expect(Math.abs(b)).toBeLessThan(0.1)
  })
})

describe('nearestIndex / buildLabPalette', () => {
  const entries = buildLabPalette(tiny)
  it('各取最近色', () => {
    expect(nearestIndex(srgbToLab(10, 10, 10), entries)).toBe(0)
    expect(nearestIndex(srgbToLab(240, 240, 240), entries)).toBe(1)
    expect(nearestIndex(srgbToLab(220, 30, 30), entries)).toBe(2)
  })
  it('完全相同的色就是它自己', () => {
    for (let i = 0; i < GENERIC_PALETTE.colors.length; i++) {
      const lab = srgbToLab(...hexToRgb(GENERIC_PALETTE.colors[i].hex))
      expect(nearestIndex(lab, buildLabPalette(GENERIC_PALETTE))).toBe(i)
    }
  })
  it('空调色板返回 -1', () => {
    expect(nearestIndex([0, 0, 0], [])).toBe(-1)
  })
  it('Lab 比 RGB 距离更贴近观感：深蓝灰更接近黑而非红', () => {
    expect(nearestIndex(srgbToLab(30, 20, 60), entries)).toBe(0)
  })
})

describe('clampGrid', () => {
  it('夹范围并取整', () => {
    expect(clampGrid(1)).toBe(GRID_MIN)
    expect(clampGrid(999)).toBe(GRID_MAX)
    expect(clampGrid(29.6)).toBe(30)
    expect(clampGrid(NaN)).toBe(29)
  })
})

describe('cropSquare', () => {
  it('横图居中裁', () => {
    expect(cropSquare(400, 300)).toEqual({ x: 50, y: 0, w: 300, h: 300 })
  })
  it('竖图居中裁', () => {
    expect(cropSquare(300, 500)).toEqual({ x: 0, y: 100, w: 300, h: 300 })
  })
  it('正方形不变', () => {
    expect(cropSquare(100, 100)).toEqual({ x: 0, y: 0, w: 100, h: 100 })
  })
})

describe('downsample', () => {
  /** 构造 w×h 的 RGBA，颜色由 f(x,y) 给出 */
  const make = (w: number, h: number, f: (x: number, y: number) => [number, number, number, number]) => {
    const d = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(f(x, y), (y * w + x) * 4)
    return d
  }
  it('每块取均值', () => {
    // 左半黑、右半白，2x1 格
    const d = make(4, 2, (x) => (x < 2 ? [0, 0, 0, 255] : [255, 255, 255, 255]))
    expect(Array.from(downsample(d, 4, 2, 2, 1))).toEqual([0, 0, 0, 255, 255, 255])
  })
  it('块内混色取平均', () => {
    const d = make(2, 1, (x) => (x === 0 ? [0, 100, 200, 255] : [100, 200, 0, 255]))
    expect(Array.from(downsample(d, 2, 1, 1, 1))).toEqual([50, 150, 100])
  })
  it('透明按白底合成', () => {
    const d = make(1, 1, () => [0, 0, 0, 0])
    expect(Array.from(downsample(d, 1, 1, 1, 1))).toEqual([255, 255, 255])
  })
  it('目标比源还大时不越界', () => {
    const d = make(2, 2, () => [10, 20, 30, 255])
    const out = downsample(d, 2, 2, 4, 4)
    expect(out).toHaveLength(48)
    expect(Array.from(out.subarray(0, 3))).toEqual([10, 20, 30])
  })
})

describe('mapToPalette', () => {
  it('每格映射到最近色下标', () => {
    const rgb = [5, 5, 5, 250, 250, 250, 230, 20, 20]
    expect(Array.from(mapToPalette(rgb, buildLabPalette(tiny)))).toEqual([0, 1, 2])
  })
})

describe('usageStats', () => {
  it('按用量降序、同量按色号，忽略零用量', () => {
    const rows = usageStats(new Uint16Array([1, 0, 1, 2, 2, 1]), tiny)
    expect(rows.map((r) => [r.code, r.count])).toEqual([
      ['T2', 3],
      ['T3', 2],
      ['T1', 1],
    ])
    expect(usageStats(new Uint16Array([2, 2]), tiny)).toHaveLength(1)
  })
  it('越界下标被忽略', () => {
    expect(usageStats(new Uint16Array([9]), tiny)).toEqual([])
  })
})

describe('contrastColor', () => {
  it('浅底黑字，深底白字', () => {
    expect(contrastColor('#ffffff')).toBe('#000000')
    expect(contrastColor('#ffd91f')).toBe('#000000')
    expect(contrastColor('#14234f')).toBe('#ffffff')
  })
})

describe('chooseCell / patternLayout', () => {
  it('格数多则单格小', () => {
    expect(chooseCell(29)).toBe(40)
    expect(chooseCell(52)).toBe(32)
    expect(chooseCell(100)).toBe(24)
  })
  it('图纸区 = n 格 + 两侧边距', () => {
    expect(patternLayout(29)).toEqual({ cell: 40, margin: 40, width: 29 * 40 + 80, height: 29 * 40 + 80 })
    expect(patternLayout(52).width).toBe(52 * 32 + 64)
  })
})

describe('legendLayout', () => {
  it('按宽度排列多列', () => {
    const l = legendLayout(1240, 10, 40)
    expect(l.itemW).toBe(240)
    expect(l.cols).toBe(5)
    expect(l.rows).toBe(2)
    expect(l.height).toBe(80 + 2 * l.itemH)
  })
  it('没有颜色高为 0', () => {
    expect(legendLayout(1000, 0, 40).height).toBe(0)
  })
  it('图纸比单项还窄时至少 1 列', () => {
    expect(legendLayout(100, 3, 40).cols).toBe(1)
  })
})

describe('validatePalette / 内置调色板', () => {
  it('内置调色板通过校验且不少于 48 色', () => {
    for (const p of PALETTES) expect(validatePalette(p)).toEqual([])
    expect(GENERIC_PALETTE.colors.length).toBeGreaterThanOrEqual(48)
  })
  it('内置色号形如 A01，色值互不重复', () => {
    expect(GENERIC_PALETTE.colors.every((c) => /^A\d{2}$/.test(c.code))).toBe(true)
    expect(new Set(GENERIC_PALETTE.colors.map((c) => c.hex)).size).toBe(GENERIC_PALETTE.colors.length)
  })
  it('能发现空、重复、非法色值', () => {
    expect(validatePalette({ id: 'x', name: 'x', colors: [] })).toEqual(['调色板为空'])
    const errs = validatePalette({
      id: 'x',
      name: 'x',
      colors: [
        { code: 'A', name: 'a', hex: '#000000' },
        { code: 'A', name: 'b', hex: 'xyz' },
      ],
    })
    expect(errs).toHaveLength(2)
  })
})

describe('usageText', () => {
  it('一色一行，格式 色号 名称 #色值', () => {
    const rows = [
      { index: 0, code: 'A01', name: '白', hex: '#ffffff', count: 3 },
      { index: 1, code: 'A02', name: '黑', hex: '#000000', count: 12 },
    ]
    expect(usageText(rows)).toBe('A01 白 #ffffff\nA02 黑 #000000')
  })
  it('空数据得到空串', () => {
    expect(usageText([])).toBe('')
  })
})

describe('调色板档位', () => {
  it('24 / 48 / 72 / 96 / 144 色，由少到多', () => {
    expect(PALETTES.map((p) => p.colors.length)).toEqual([24, 48, 72, 96, 144])
  })
  it('每套内色号、色值都不重复', () => {
    for (const p of PALETTES) {
      expect(new Set(p.colors.map((c) => c.code)).size).toBe(p.colors.length)
      expect(new Set(p.colors.map((c) => c.hex)).size).toBe(p.colors.length)
    }
  })
  it('大档位包含 48 色基础色（色号一致）', () => {
    const base = GENERIC_PALETTE.colors.map((c) => c.code)
    for (const p of PALETTES.slice(2)) expect(p.colors.slice(0, 48).map((c) => c.code)).toEqual(base)
  })
})

describe('percentText', () => {
  it('保留一位小数', () => {
    expect(percentText(1, 8)).toBe('12.5%')
    expect(percentText(1, 3)).toBe('33.3%')
  })
  it('极小占比与零值', () => {
    expect(percentText(1, 5000)).toBe('<0.1%')
    expect(percentText(0, 10)).toBe('0%')
    expect(percentText(3, 0)).toBe('0%')
  })
})
