import { describe, expect, it } from 'vitest'
import { GRAVITY } from '../level/logic'
import { clampAngle, clientToView, edgeInclination, includedAngle, nearestRay, normalize, pointAngle, polar, snapAngle, surfaceInclination, sweepAngle } from './logic'

/** 圆心 */
const O = { x: 0, y: 0 }
/** 重力简写 */
const G = GRAVITY

describe('normalize / pointAngle / polar', () => {
  it('normalize 处理负数、超圈、-0', () => {
    expect(normalize(-90)).toBe(270)
    expect(normalize(720)).toBe(0)
    expect(normalize(-360)).toBe(0)
    expect(Object.is(normalize(-0), 0)).toBe(true)
  })
  it('pointAngle 屏幕上方为 90，右为 0，下为 270', () => {
    expect(pointAngle(O, { x: 0, y: -10 })).toBeCloseTo(90)
    expect(pointAngle(O, { x: 10, y: 0 })).toBeCloseTo(0)
    expect(pointAngle(O, { x: 0, y: 10 })).toBeCloseTo(270)
    expect(pointAngle(O, { x: -10, y: 0 })).toBeCloseTo(180)
  })
  it('重合点返回 null', () => {
    expect(pointAngle(O, O)).toBeNull()
  })
  it('polar 与 pointAngle 互逆', () => {
    const p = polar({ x: 5, y: 5 }, 10, 37)
    expect(pointAngle({ x: 5, y: 5 }, p)).toBeCloseTo(37)
    expect(polar(O, 10, 90).y).toBeCloseTo(-10)
  })
})

describe('sweepAngle / includedAngle', () => {
  it('跨 0 度的转角', () => {
    expect(sweepAngle(350, 10)).toBeCloseTo(20)
    expect(sweepAngle(10, 350)).toBeCloseTo(340)
  })
  it('夹角取小侧', () => {
    expect(includedAngle(350, 10)).toBeCloseTo(20)
    expect(includedAngle(0, 180)).toBeCloseTo(180)
    expect(includedAngle(0, 270)).toBeCloseTo(90)
    expect(includedAngle(30, 30)).toBe(0)
  })
})

describe('clampAngle', () => {
  it('全圆只归一', () => {
    expect(clampAngle(-30, 'full')).toBe(330)
  })
  it('半圆上半区不变，下半区夹到近端', () => {
    expect(clampAngle(120, 'half')).toBe(120)
    expect(clampAngle(200, 'half')).toBe(180)
    expect(clampAngle(340, 'half')).toBe(0)
  })
})

describe('snapAngle / nearestRay', () => {
  it('吸附到 5 的倍数', () => {
    expect(snapAngle(47, 5)).toBe(45)
    expect(snapAngle(359, 5)).toBe(0)
  })
  it('步长非法不吸附', () => {
    expect(snapAngle(47.3, 0)).toBeCloseTo(47.3)
    expect(snapAngle(-10, -5)).toBe(350)
  })
  it('找最近射线，含跨 0 度与空列表', () => {
    expect(nearestRay([0, 90], 80)).toBe(1)
    expect(nearestRay([10, 180], 350)).toBe(0)
    expect(nearestRay([], 10)).toBe(-1)
  })
})

describe('clientToView', () => {
  it('按比例换算', () => {
    expect(clientToView({ x: 60, y: 45 }, { left: 10, top: 20, width: 100, height: 50 }, 300, 150)).toEqual({ x: 150, y: 75 })
  })
  it('零尺寸返回 null', () => {
    expect(clientToView({ x: 1, y: 1 }, { left: 0, top: 0, width: 0, height: 10 }, 300, 150)).toBeNull()
  })
})

describe('倾角模式', () => {
  it('贴边：竖着 90、横着 0、斜 30 度', () => {
    expect(edgeInclination({ x: 0, y: G, z: 0 })).toBeCloseTo(90)
    expect(edgeInclination({ x: G, y: 0, z: 0 })).toBeCloseTo(0)
    expect(edgeInclination({ x: -G, y: 0, z: 0 })).toBeCloseTo(0)
    const a = (30 * Math.PI) / 180
    expect(edgeInclination({ x: G * Math.sin(a), y: G * Math.cos(a), z: 0 })).toBeCloseTo(60)
  })
  it('贴边：倒过来也是 90', () => {
    expect(edgeInclination({ x: 0, y: -G, z: 0 })).toBeCloseTo(90)
  })
  it('贴面：平放 0，竖直 90', () => {
    expect(surfaceInclination({ x: 0, y: 0, z: G })).toBeCloseTo(0)
    expect(surfaceInclination({ x: 0, y: G, z: 0 })).toBeCloseTo(90)
  })
})
