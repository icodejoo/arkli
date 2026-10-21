import { describe, expect, it } from 'vitest'
import {
  BALL_SIZE,
  DROP_BOTTOM,
  DROP_SIZE,
  EDGE_MARGIN,
  Y_MIN,
  clampX,
  clampY,
  dropCenter,
  exceedsDrag,
  floatBallLabel,
  inDropZone,
  normalizePos,
  parsePos,
  sideX,
  snapSide,
} from './floatBall'

const VW = 360
const VH = 800

describe('吸边与夹紧', () => {
  it('中心在左半吸左，右半吸右', () => {
    expect(snapSide(50, VW)).toBe('left')
    expect(snapSide(250, VW)).toBe('right')
  })
  it('停靠横坐标留边距', () => {
    expect(sideX('left', VW)).toBe(EDGE_MARGIN)
    expect(sideX('right', VW)).toBe(VW - BALL_SIZE - EDGE_MARGIN)
  })
  it('纵向夹在可见范围，拖出屏幕外被夹回', () => {
    expect(clampY(-100, VH)).toBe(Y_MIN)
    expect(clampY(5000, VH)).toBeLessThan(VH - BALL_SIZE)
    expect(clampY(300, VH)).toBe(300)
  })
  it('横向夹在屏幕内', () => {
    expect(clampX(-30, VW)).toBe(0)
    expect(clampX(999, VW)).toBe(VW - BALL_SIZE)
  })
})

describe('投放区判定', () => {
  const c = dropCenter(VW, VH)
  it('中心点在底部居中', () => {
    expect(c).toEqual({ x: VW / 2, y: VH - DROP_BOTTOM - DROP_SIZE / 2 })
  })
  it('圆球中心对准投放区命中，远处不中', () => {
    expect(inDropZone(c.x - BALL_SIZE / 2, c.y - BALL_SIZE / 2, VW, VH)).toBe(true)
    expect(inDropZone(0, 100, VW, VH)).toBe(false)
  })
})

describe('其它', () => {
  it('拖动阈值', () => {
    expect(exceedsDrag(2, 2)).toBe(false)
    expect(exceedsDrag(10, 0)).toBe(true)
  })
  it('位置解析：合法、损坏、缺失', () => {
    expect(parsePos('{"side":"left","y":120}')).toEqual({ side: 'left', y: 120 })
    expect(parsePos('{"side":"top","y":1}')).toBeNull()
    expect(parsePos('坏的')).toBeNull()
    expect(parsePos(null)).toBeNull()
  })
  it('规范化缓存值：合法、非法回落 null', () => {
    expect(normalizePos({ side: 'right', y: 3 })).toEqual({ side: 'right', y: 3 })
    expect(normalizePos({ side: 'top', y: 3 })).toBeNull()
    expect(normalizePos({ side: 'left', y: NaN })).toBeNull()
    expect(normalizePos(null)).toBeNull()
  })
  it('无障碍标签', () => {
    expect(floatBallLabel('番茄钟')).toBe('浮窗：番茄钟，点击返回')
  })
})
