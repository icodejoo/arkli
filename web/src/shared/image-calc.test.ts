import { describe, expect, it } from 'vitest'
import {
  baseName,
  changeText,
  exceedsCanvas,
  extToMime,
  fitMaxEdge,
  formatBytes,
  gridCells,
  halvingSteps,
  MAX_CANVAS_PIXELS,
  MAX_CANVAS_SIDE,
  mimeToExt,
  outputName,
  stitchLayout,
} from './image-calc'

describe('exceedsCanvas', () => {
  it('边界值', () => {
    expect(exceedsCanvas(8000, 8000)).toBe(false)
    expect(exceedsCanvas(8001, 8000)).toBe(true)
    expect(exceedsCanvas(MAX_CANVAS_SIDE + 1, 10)).toBe(true)
    expect(exceedsCanvas(MAX_CANVAS_SIDE, 10)).toBe(false)
    expect(MAX_CANVAS_PIXELS).toBe(64_000_000)
  })
})

describe('fitMaxEdge', () => {
  it('超限按比例缩小', () => {
    expect(fitMaxEdge(4000, 3000, 2000)).toEqual({ width: 2000, height: 1500, scale: 0.5 })
    expect(fitMaxEdge(3000, 4000, 1000)).toEqual({ width: 750, height: 1000, scale: 0.25 })
  })
  it('不放大、0 表示不限', () => {
    expect(fitMaxEdge(100, 50, 200).scale).toBe(1)
    expect(fitMaxEdge(5000, 5000, 0)).toEqual({ width: 5000, height: 5000, scale: 1 })
  })
  it('极端长宽比最小为 1', () => {
    expect(fitMaxEdge(10000, 1, 100).height).toBe(1)
  })
})

describe('halvingSteps', () => {
  it('缩小超过一半逐级减半', () => {
    expect(halvingSteps(4000, 3000, 1000, 750)).toEqual([
      { width: 2000, height: 1500 },
      { width: 1000, height: 750 },
    ])
  })
  it('小幅缩小或放大只有一步', () => {
    expect(halvingSteps(100, 100, 60, 60)).toEqual([{ width: 60, height: 60 }])
    expect(halvingSteps(100, 100, 200, 200)).toEqual([{ width: 200, height: 200 }])
  })
})

describe('formatBytes / changeText', () => {
  it('格式化', () => {
    expect(formatBytes(532)).toBe('532 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(2.3 * 1024 * 1024)).toBe('2.30 MB')
    expect(formatBytes(-1)).toBe('0 B')
  })
  it('变化率', () => {
    expect(changeText(1000, 380)).toBe('-62%')
    expect(changeText(1000, 1050)).toBe('+5%')
    expect(changeText(1000, 1000)).toBe('0%')
    expect(changeText(0, 10)).toBe('--')
  })
})

describe('MIME 与文件名', () => {
  it('mimeToExt / extToMime', () => {
    expect(mimeToExt('image/jpeg')).toBe('jpg')
    expect(mimeToExt('IMAGE/WEBP')).toBe('webp')
    expect(mimeToExt('x/y')).toBe('bin')
    expect(extToMime('a.JPG')).toBe('image/jpeg')
    expect(extToMime('png')).toBe('image/png')
    expect(extToMime('a.xyz')).toBe('')
  })
  it('baseName / outputName', () => {
    expect(baseName('a.b.png')).toBe('a.b')
    expect(baseName('.png')).toBe('.png')
    expect(baseName('noext')).toBe('noext')
    expect(outputName('photo.png', 'image/jpeg', '-min')).toBe('photo-min.jpg')
  })
})

describe('gridCells', () => {
  it('1x3 无缝均分', () => {
    const { region, cells } = gridCells(300, 200, 1, 3, false)
    expect(region).toEqual({ x: 0, y: 0, w: 300, h: 200 })
    expect(cells.map((c) => [c.x, c.w])).toEqual([[0, 100], [100, 100], [200, 100]])
    expect(cells.map((c) => c.index)).toEqual([1, 2, 3])
  })
  it('3x3 正方形居中裁剪', () => {
    const { region, cells } = gridCells(400, 300, 3, 3, true)
    expect(region).toEqual({ x: 50, y: 0, w: 300, h: 300 })
    expect(cells).toHaveLength(9)
    expect(cells[0]).toMatchObject({ x: 50, y: 0, w: 100, h: 100 })
    expect(cells[8]).toMatchObject({ x: 250, y: 200, w: 100, h: 100, row: 2, col: 2 })
  })
  it('不能整除时总宽仍对得上', () => {
    const { cells } = gridCells(100, 100, 1, 3, false)
    expect(cells.reduce((s, c) => s + c.w, 0)).toBe(100)
    expect(cells[2].x + cells[2].w).toBe(100)
  })
})

describe('stitchLayout', () => {
  const sizes = [{ width: 100, height: 50 }, { width: 200, height: 80 }]
  it('纵拼统一宽度：按最窄缩放，间距计入', () => {
    const l = stitchLayout(sizes, { direction: 'v', gap: 10, unify: true, align: 'start' })
    expect(l).toMatchObject({ width: 100, height: 50 + 10 + 40 })
    expect(l.items[1]).toEqual({ x: 0, y: 60, w: 100, h: 40 })
  })
  it('纵拼不统一：画布取最宽，居中/靠右对齐', () => {
    const c = stitchLayout(sizes, { direction: 'v', gap: 0, unify: false, align: 'center' })
    expect(c.width).toBe(200)
    expect(c.items[0].x).toBe(50)
    const e = stitchLayout(sizes, { direction: 'v', gap: 0, unify: false, align: 'end' })
    expect(e.items[0].x).toBe(100)
  })
  it('横拼统一高度', () => {
    const l = stitchLayout(sizes, { direction: 'h', gap: 4, unify: true, align: 'start' })
    expect(l.height).toBe(50)
    expect(l.items[0]).toEqual({ x: 0, y: 0, w: 100, h: 50 })
    expect(l.items[1]).toEqual({ x: 104, y: 0, w: 125, h: 50 })
    expect(l.width).toBe(229)
  })
  it('空输入', () => {
    expect(stitchLayout([], { direction: 'v', gap: 0, unify: true, align: 'start' })).toEqual({ width: 0, height: 0, items: [] })
  })
})
