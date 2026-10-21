import { describe, expect, it } from 'vitest'
import {
  addStroke, appendPoint, canRedo, canUndo, canvasScale, clampWidth, clearStack, createStack, exportName,
  isHexColor, isValidWidth, MAX_EXPORT_EDGE, MAX_POINTS, pixelSize, redo, undo, type Stroke,
} from './logic'

/** 造一条笔画 */
const mk = (x: number): Stroke => ({ points: [{ x, y: 0 }], color: '#000000', width: 4, erase: false })

describe('笔画栈', () => {
  it('新建为空', () => {
    const s = createStack()
    expect(s.strokes).toEqual([])
    expect(canUndo(s)).toBe(false)
    expect(canRedo(s)).toBe(false)
  })

  it('addStroke 不改原栈', () => {
    const s = createStack()
    const n = addStroke(s, mk(1))
    expect(s.strokes.length).toBe(0)
    expect(n.strokes.length).toBe(1)
  })

  it('撤销与重做往返', () => {
    let s = addStroke(addStroke(createStack(), mk(1)), mk(2))
    s = undo(s)
    expect(s.strokes.length).toBe(1)
    expect(canRedo(s)).toBe(true)
    s = redo(s)
    expect(s.strokes.map((t) => t.points[0].x)).toEqual([1, 2])
    expect(canRedo(s)).toBe(false)
  })

  it('空栈撤销/重做原样返回', () => {
    const s = createStack()
    expect(undo(s)).toBe(s)
    expect(redo(s)).toBe(s)
  })

  it('新笔画清空重做栈', () => {
    let s = undo(addStroke(createStack(), mk(1)))
    expect(canRedo(s)).toBe(true)
    s = addStroke(s, mk(2))
    expect(canRedo(s)).toBe(false)
  })

  it('连续撤销后按相反顺序重做', () => {
    let s = addStroke(addStroke(addStroke(createStack(), mk(1)), mk(2)), mk(3))
    s = undo(undo(s))
    s = redo(s)
    expect(s.strokes.map((t) => t.points[0].x)).toEqual([1, 2])
  })

  it('clearStack 返回空栈', () => {
    expect(clearStack()).toEqual({ strokes: [], redo: [] })
  })
})

describe('clampWidth / isHexColor', () => {
  it('范围与非法值', () => {
    expect(clampWidth(0)).toBe(1)
    expect(clampWidth(100)).toBe(60)
    expect(clampWidth(5.6)).toBe(6)
    expect(clampWidth(NaN)).toBe(1)
  })

  it('颜色格式', () => {
    expect(isHexColor('#fff')).toBe(true)
    expect(isHexColor('#A1b2C3')).toBe(true)
    expect(isHexColor('red')).toBe(false)
    expect(isHexColor('#ffff')).toBe(false)
  })
})

describe('appendPoint', () => {
  it('太近的点丢弃', () => {
    const ps = [{ x: 0, y: 0 }]
    expect(appendPoint(ps, { x: 0.2, y: 0.2 })).toBe(false)
    expect(appendPoint(ps, { x: 5, y: 0 })).toBe(true)
    expect(ps.length).toBe(2)
  })

  it('空数组直接加入；NaN 丢弃', () => {
    const ps: { x: number; y: number }[] = []
    expect(appendPoint(ps, { x: 1, y: 1 })).toBe(true)
    expect(appendPoint(ps, { x: NaN, y: 1 })).toBe(false)
  })

  it('超过点数上限不再加', () => {
    const ps = Array.from({ length: MAX_POINTS }, (_, i) => ({ x: i * 10, y: 0 }))
    expect(appendPoint(ps, { x: -999, y: 0 })).toBe(false)
  })
})

describe('canvasScale / pixelSize', () => {
  it('dpr 封顶 2', () => {
    expect(canvasScale(400, 800, 3)).toBe(2)
    expect(canvasScale(400, 800, 1.5)).toBe(1.5)
  })

  it('非法 dpr 按 1', () => {
    expect(canvasScale(400, 800, 0)).toBe(1)
    expect(canvasScale(400, 800, NaN)).toBe(1)
  })

  it('最长边封顶', () => {
    const s = canvasScale(3000, 1000, 2)
    expect(3000 * s).toBeLessThanOrEqual(MAX_EXPORT_EDGE)
  })

  it('pixelSize 至少 1', () => {
    expect(pixelSize(100, 50, 2)).toEqual({ width: 200, height: 100 })
    expect(pixelSize(0, 0, 2)).toEqual({ width: 1, height: 1 })
  })
})

describe('exportName', () => {
  it('格式固定', () => {
    expect(exportName(new Date(2026, 0, 2, 3, 4, 5))).toBe('sketch-20260102-030405.png')
  })
})

describe('isValidWidth', () => {
  it('只认范围内的有限数，非法缓存回落默认', () => {
    expect(isValidWidth(6)).toBe(true)
    expect(isValidWidth(0)).toBe(false)
    expect(isValidWidth(61)).toBe(false)
    expect(isValidWidth(NaN)).toBe(false)
    expect(isValidWidth('6')).toBe(false)
  })
})
