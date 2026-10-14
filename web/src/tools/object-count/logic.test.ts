import { describe, expect, it } from 'vitest'
import {
  binarize,
  defaultMinArea,
  detect,
  emptyEdits,
  filterByArea,
  guessMode,
  labelComponents,
  otsu,
  sortMarkers,
  toGray,
  toggleAt,
  visibleMarkers,
} from './logic'

/** 用字符画造灰度图：`#` 为深色物体(0)，`.` 为白底(255)，`o` 为浅灰物体(200，底为 20 时用) */
function bitmap(rows: string[], map: Record<string, number> = { '#': 0, '.': 255 }): { gray: Uint8Array; w: number; h: number } {
  const h = rows.length
  const w = rows[0].length
  const gray = new Uint8Array(w * h)
  rows.forEach((r, y) => r.split('').forEach((ch, x) => (gray[y * w + x] = map[ch])))
  return { gray, w, h }
}

describe('toGray', () => {
  it('纯色与权重', () => {
    expect(toGray([255, 0, 0, 255], 1, 1)[0]).toBe(76)
    expect(toGray([0, 255, 0, 255], 1, 1)[0]).toBe(150)
    expect(toGray([255, 255, 255, 255], 1, 1)[0]).toBe(255)
  })
  it('透明像素按白底', () => {
    expect(toGray([0, 0, 0, 0], 1, 1)[0]).toBe(255)
  })
})

describe('otsu', () => {
  it('双峰分在两峰之间', () => {
    const g = new Uint8Array(100)
    g.fill(30, 0, 50)
    g.fill(220, 50)
    const t = otsu(g)
    expect(t).toBeGreaterThanOrEqual(30)
    expect(t).toBeLessThan(220)
  })
  it('空数组与纯色不崩', () => {
    expect(otsu(new Uint8Array(0))).toBe(127)
    expect(() => otsu(new Uint8Array(10).fill(255))).not.toThrow()
  })
})

describe('binarize', () => {
  it('亮物体与暗物体', () => {
    const g = new Uint8Array([10, 100, 200])
    expect(Array.from(binarize(g, 100, 'dark'))).toEqual([1, 1, 0])
    expect(Array.from(binarize(g, 100, 'bright'))).toEqual([0, 0, 1])
  })
})

describe('guessMode', () => {
  it('白底黑物体 → dark；黑底白物体 → bright', () => {
    const a = bitmap(['.....', '.#.#.', '.....'])
    expect(guessMode(a.gray, a.w, a.h, 128)).toBe('dark')
    const b = bitmap(['#####', '#.#.#', '#####'])
    expect(guessMode(b.gray, b.w, b.h, 128)).toBe('bright')
  })
  it('单行 / 单列图不崩', () => {
    expect(() => guessMode(new Uint8Array([0, 255, 0]), 3, 1, 128)).not.toThrow()
    expect(() => guessMode(new Uint8Array([0, 255]), 1, 2, 128)).not.toThrow()
  })
})

describe('labelComponents', () => {
  it('分离的块各算一个，并给出面积与质心', () => {
    const { gray, w, h } = bitmap(['##...##', '##...##', '.......', '..###..'])
    const comps = labelComponents(binarize(gray, 128, 'dark'), w, h)
    expect(comps.map((c) => c.area)).toEqual([4, 4, 3])
    expect(comps[0].cx).toBeCloseTo(0.5)
    expect(comps[0].cy).toBeCloseTo(0.5)
    expect(comps[2].cx).toBeCloseTo(3)
  })
  it('8 邻域：对角相连算同一个', () => {
    const { gray, w, h } = bitmap(['#..', '.#.', '..#'])
    expect(labelComponents(binarize(gray, 128, 'dark'), w, h)).toHaveLength(1)
  })
  it('粘连的物体被算成一个', () => {
    const { gray, w, h } = bitmap(['##..##', '######', '##..##'])
    const comps = labelComponents(binarize(gray, 128, 'dark'), w, h)
    expect(comps).toHaveLength(1)
    expect(comps[0].area).toBe(14)
  })
  it('空图与全空白', () => {
    expect(labelComponents(new Uint8Array(0), 0, 0)).toEqual([])
    const { gray, w, h } = bitmap(['....', '....'])
    expect(labelComponents(binarize(gray, 128, 'dark'), w, h)).toEqual([])
  })
  it('不修改入参，大图不爆栈', () => {
    const mask = new Uint8Array(400 * 400).fill(1)
    const copy = mask.slice()
    const comps = labelComponents(mask, 400, 400)
    expect(comps).toHaveLength(1)
    expect(comps[0].area).toBe(160000)
    expect(mask).toEqual(copy)
  })
})

describe('filterByArea', () => {
  const comps = [
    { area: 1, cx: 0, cy: 0 },
    { area: 10, cx: 1, cy: 1 },
    { area: 100, cx: 2, cy: 2 },
  ]
  it('按下限过滤噪点', () => {
    expect(filterByArea(comps, 5).map((c) => c.area)).toEqual([10, 100])
  })
  it('按上限丢背景，边界含等号', () => {
    expect(filterByArea(comps, 1, 10).map((c) => c.area)).toEqual([1, 10])
  })
})

describe('defaultMinArea', () => {
  it('随画面缩放且有下限', () => {
    expect(defaultMinArea(800, 600)).toBe(96)
    expect(defaultMinArea(10, 10)).toBe(4)
  })
})

describe('sortMarkers', () => {
  it('同一行从左到右，行之间从上到下', () => {
    const out = sortMarkers(
      [
        { x: 50, y: 12 },
        { x: 10, y: 30 },
        { x: 10, y: 10 },
        { x: 30, y: 11 },
      ],
      5,
    )
    expect(out.map((p) => [p.x, p.y])).toEqual([
      [10, 10],
      [30, 11],
      [50, 12],
      [10, 30],
    ])
  })
  it('空数组', () => {
    expect(sortMarkers([], 5)).toEqual([])
  })
})

describe('detect', () => {
  it('分离块 + 噪点：噪点被最小面积滤掉', () => {
    const { gray, w, h } = bitmap(['##..........', '##....#.....', '........###.', '........###.', '............'])
    const pts = detect(gray, w, h, { threshold: 128, mode: 'dark', minArea: 3 })
    expect(pts).toHaveLength(2)
  })
  it('亮物体模式', () => {
    const { gray, w, h } = bitmap(['....', '.oo.', '....'], { '.': 20, o: 200 })
    expect(detect(gray, w, h, { threshold: 100, mode: 'bright', minArea: 1 })).toHaveLength(1)
  })
  it('极性选反时背景成一整块被丢弃，不会误算 1 个', () => {
    const { gray, w, h } = bitmap(['....', '.##.', '....'])
    expect(detect(gray, w, h, { threshold: 128, mode: 'bright', minArea: 1 })).toHaveLength(0)
  })
  it('空图与纯白图为 0', () => {
    expect(detect(new Uint8Array(0), 0, 0, { threshold: 128, mode: 'dark', minArea: 1 })).toEqual([])
    expect(detect(new Uint8Array(16).fill(255), 4, 4, { threshold: 128, mode: 'dark', minArea: 1 })).toEqual([])
  })
})

describe('手动修正', () => {
  const auto = [
    { x: 10, y: 10 },
    { x: 50, y: 50 },
  ]
  it('点空白处添加', () => {
    const e = toggleAt(auto, emptyEdits(), 100, 100, 5)
    expect(e.added).toEqual([{ x: 100, y: 100 }])
    expect(visibleMarkers(auto, e)).toHaveLength(3)
  })
  it('点中自动点：删除它', () => {
    const e = toggleAt(auto, emptyEdits(), 12, 11, 5)
    expect(e.removed).toEqual([{ x: 10, y: 10 }])
    expect(visibleMarkers(auto, e)).toEqual([{ x: 50, y: 50 }])
  })
  it('点中手动添加的点：再点一次取消', () => {
    const e1 = toggleAt(auto, emptyEdits(), 100, 100, 5)
    const e2 = toggleAt(auto, e1, 101, 100, 5)
    expect(e2.added).toEqual([])
    expect(visibleMarkers(auto, e2)).toHaveLength(2)
  })
  it('已删除的自动点不再被命中，点它会重新添加一个手动点', () => {
    const e1 = toggleAt(auto, emptyEdits(), 10, 10, 5)
    const e2 = toggleAt(auto, e1, 10, 10, 5)
    expect(e2.added).toEqual([{ x: 10, y: 10 }])
    expect(visibleMarkers(auto, e2)).toHaveLength(2)
  })
  it('命中最近的那个，且不修改入参', () => {
    const near = [
      { x: 10, y: 10 },
      { x: 16, y: 10 },
    ]
    const start = emptyEdits()
    const e = toggleAt(near, start, 14, 10, 10)
    expect(e.removed).toEqual([{ x: 16, y: 10 }])
    expect(start.removed).toEqual([])
  })
  it('emptyEdits 每次是新对象', () => {
    expect(emptyEdits()).not.toBe(emptyEdits())
  })
})
