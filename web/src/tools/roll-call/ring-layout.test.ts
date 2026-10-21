import { describe, expect, it } from 'vitest'
import {
  buildRingLayout,
  calcAtlasGrid,
  calcAtlasUv,
  calcRingMotion,
  calcStopAngle,
  DEFAULT_MAX_CHARS,
  ELLIPSIS,
  MIN_RINGS,
  SLOTS_PER_RING,
  truncateName,
} from './ring-layout'

describe('ring-layout: truncateName', () => {
  it('短名字不截断', () => {
    expect(truncateName('张三')).toBe('张三')
    expect(truncateName('李四五六七八', 6)).toBe('李四五六七八')
  })

  it('超长名字按指定长度截断并补充省略号', () => {
    expect(truncateName('古力娜扎尔·买买提', 6)).toBe(`古力娜扎尔${ELLIPSIS}`)
    expect(truncateName('欧阳大富贵', 4)).toBe(`欧阳大${ELLIPSIS}`)
  })

  it('首尾空格自动清理', () => {
    expect(truncateName('  王五  ', DEFAULT_MAX_CHARS)).toBe('王五')
  })
})

describe('ring-layout: buildRingLayout', () => {
  it('小名单时至少维持最少环数，槽位完整铺满', () => {
    const layout = buildRingLayout(['张三', '李四'], '张三')
    expect(layout.ringCount).toBeGreaterThanOrEqual(MIN_RINGS)
    expect(layout.rings).toHaveLength(layout.ringCount)
    expect(layout.totalSlots).toBe(layout.ringCount * SLOTS_PER_RING)

    const targetRing = layout.rings[layout.targetRingIndex]
    const targetSlot = targetRing.slots[layout.targetSlotIndex]
    expect(targetSlot.isWinner).toBe(true)
    expect(targetSlot.name).toBe('张三')

    let winnerCount = 0
    for (const r of layout.rings) {
      expect(r.slots).toHaveLength(SLOTS_PER_RING)
      for (const s of r.slots) {
        if (s.isWinner) winnerCount++
      }
    }
    expect(winnerCount).toBe(1)
  })

  it('几百人大名单支持按 16 人/环切分', () => {
    const bigList = Array.from({ length: 320 }, (_, i) => `同学_${i + 1}`)
    const winner = '同学_188'
    const layout = buildRingLayout(bigList, winner)

    expect(layout.ringCount).toBe(20)
    expect(layout.rings).toHaveLength(20)
    expect(layout.totalSlots).toBe(320)

    const targetRing = layout.rings[layout.targetRingIndex]
    const targetSlot = targetRing.slots[layout.targetSlotIndex]
    expect(targetSlot.isWinner).toBe(true)
    expect(targetSlot.name).toBe(winner)
  })

  it('空名单能安全兜底', () => {
    const layout = buildRingLayout([], '默认选手')
    expect(layout.ringCount).toBe(MIN_RINGS)
    const targetSlot = layout.rings[layout.targetRingIndex].slots[layout.targetSlotIndex]
    expect(targetSlot.name).toBe('默认选手')
    expect(targetSlot.isWinner).toBe(true)
  })
})

describe('ring-layout: calcAtlasGrid & calcAtlasUv', () => {
  it('正确计算图集行列数', () => {
    expect(calcAtlasGrid(48, 8)).toEqual({ columns: 8, rows: 6 })
    expect(calcAtlasGrid(49, 8)).toEqual({ columns: 8, rows: 7 })
    expect(calcAtlasGrid(0, 8)).toEqual({ columns: 8, rows: 1 })
  })

  it('正确计算 UV 坐标且在 [0, 1] 范围内', () => {
    const { uMin, vMin, uMax, vMax } = calcAtlasUv(0, 8, 4)
    expect(uMin).toBe(0)
    expect(uMax).toBe(0.125)
    expect(vMax).toBe(1)
    expect(vMin).toBe(0.75)

    const last = calcAtlasUv(31, 8, 4)
    expect(last.uMax).toBe(1)
    expect(last.vMin).toBe(0)
  })
})

describe('ring-layout: calcStopAngle', () => {
  it('槽位 0 时旋转整圈后仍对准 0', () => {
    const rot = calcStopAngle(0, 16, 3, 1)
    expect(rot).toBe(6 * Math.PI)
  })

  it('非 0 槽位旋转后与槽位自身夹角抵消，对准正前方', () => {
    const slotIndex = 4
    const totalSlots = 16
    const rot = calcStopAngle(slotIndex, totalSlots, 2, 1)
    const slotAngle = (slotIndex / totalSlots) * Math.PI * 2
    const finalAngle = (slotAngle + rot) % (Math.PI * 2)
    expect(Math.abs(finalAngle)).toBeLessThan(1e-10)
  })
})

describe('ring-layout: calcRingMotion', () => {
  it('目标环最后停下，非目标环依次提前减速停下', () => {
    const motionTarget = calcRingMotion(1, 3, 1)
    expect(motionTarget.stopRatio).toBe(1.0)

    const motionOther0 = calcRingMotion(0, 3, 1)
    const motionOther2 = calcRingMotion(2, 3, 1)
    expect(motionOther0.stopRatio).toBeLessThan(1.0)
    expect(motionOther2.stopRatio).toBeLessThan(1.0)
    expect(motionOther0.stopRatio).toBeGreaterThanOrEqual(0.55)

    expect(motionOther0.direction).toBe(1)
    expect(motionTarget.direction).toBe(-1)
  })
})
