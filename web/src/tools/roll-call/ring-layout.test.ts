import { describe, expect, it } from 'vitest'
import {
  buildRingLayout,
  calcAtlasGrid,
  calcAtlasUv,
  calcRingMotion,
  SETTLE_HOLD_MS,
  calcStopAngle,
  ACTIVE_FRAME_MS,
  IDLE_FRAME_MS,
  calcPixelRatio,
  calcTargetRounds,
  rpmToRadPerMs,
  rpsToRadPerMs,
  calcApproachAngle,
  normalizeAngle,
  shouldRenderFrame,
  calcSpinAngle,
  calcStopTarget,
  MANUAL_STOP_MS,
  SPIN_RAD_PER_MS,
  DEFAULT_MAX_CHARS,
  ELLIPSIS,
  MIN_RINGS,
  SLOTS_PER_RING,
  truncateName,
  calcDragAngle,
  calcInertiaStep,
  isHorizontalIntent,
  clampInertiaSpeed,
  smoothDragVelocity,
  DRAG_RAD_PER_PX,
  DRAG_INTENT_PX,
  INERTIA_MAX_SPEED,
  INERTIA_STOP_SPEED,
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
  it('所有转子同时停下', () => {
    const motionTarget = calcRingMotion(1, 3, 1)
    expect(motionTarget.stopRatio).toBe(1.0)

    const motionOther0 = calcRingMotion(0, 3, 1)
    const motionOther2 = calcRingMotion(2, 3, 1)
    expect(motionOther0.stopRatio).toBe(1.0)
    expect(motionOther2.stopRatio).toBe(1.0)

    expect(motionOther0.direction).toBe(1)
    expect(motionTarget.direction).toBe(-1)
  })
})

describe('ring-layout: 手动模式旋转与停止', () => {
  const full = Math.PI * 2
  const mod = (x: number) => ((x % full) + full) % full

  it('匀速角度随时间线性增长，方向跟随', () => {
    expect(calcSpinAngle(0, 1)).toBe(0)
    expect(calcSpinAngle(900, 1)).toBeCloseTo(full)
    expect(calcSpinAngle(450, -1)).toBeCloseTo(-Math.PI)
    expect(calcSpinAngle(-5, 1)).toBe(0)
  })

  it('停止终点与目标对齐同余，且沿方向前进不回头', () => {
    for (const dir of [1, -1] as const) {
      for (const from of [0, 0.3, 5, 123.4, -7]) {
        const align = calcStopAngle(5, 16, 4, dir)
        const to = calcStopTarget(from, align, dir, MANUAL_STOP_MS)
        expect(Math.min(mod(to - align), full - mod(to - align))).toBeCloseTo(0, 6)
        expect(dir * (to - from)).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('行程足够：减速起速不低于匀速，且至多多一圈', () => {
    const minTravel = (SPIN_RAD_PER_MS * MANUAL_STOP_MS) / 3
    const to = calcStopTarget(1, calcStopAngle(0, 16, 4, 1), 1, MANUAL_STOP_MS)
    expect(to - 1).toBeGreaterThanOrEqual(minTravel - 1e-9)
    expect(to - 1).toBeLessThan(minTravel + full + 1e-9)
  })
})

describe('ring-layout: 结算时间线', () => {
  it('停顿 2 秒后进入结算静止态', () => {
    expect(SETTLE_HOLD_MS).toBe(1000)
  })
})

describe('ring-layout: 帧率节流与像素比', () => {
  it('首帧必渲染，未到间隔跳过，到点渲染', () => {
    expect(shouldRenderFrame(100, 0, IDLE_FRAME_MS)).toBe(true)
    expect(shouldRenderFrame(116, 100, ACTIVE_FRAME_MS)).toBe(false)
    expect(shouldRenderFrame(133.3, 100, ACTIVE_FRAME_MS)).toBe(true)
    expect(shouldRenderFrame(133.3, 100, IDLE_FRAME_MS)).toBe(false)
    expect(shouldRenderFrame(167, 100, IDLE_FRAME_MS)).toBe(true)
  })
  it('60Hz 抖动下 30fps 隔帧渲染', () => {
    expect(shouldRenderFrame(100 + 33.2, 100, ACTIVE_FRAME_MS)).toBe(true)
  })
  it('像素比受 dpr、上限与最长边约束', () => {
    expect(calcPixelRatio(1, 300, 300)).toBe(1)
    expect(calcPixelRatio(3, 300, 300)).toBe(1.25)
    expect(calcPixelRatio(3, 800, 400)).toBeCloseTo(0.75)
  })
})

describe('ring-layout: 慢转衔接滚动', () => {
  it('角度归一到 [0, 2π)', () => {
    expect(normalizeAngle(-Math.PI / 2)).toBeCloseTo((3 * Math.PI) / 2)
    expect(normalizeAngle(5 * Math.PI)).toBeCloseTo(Math.PI)
    expect(normalizeAngle(0)).toBe(0)
  })
  it('逼近角度：起点连续、终点精确', () => {
    expect(calcApproachAngle(1, 5, 0)).toBe(1)
    expect(calcApproachAngle(1, 5, 1)).toBe(5)
    expect(calcApproachAngle(1, 5, 0.5)).toBe(3)
  })
})

describe('ring-layout: 拖动与惯性', () => {
  it('拖动角度：向右为正、与位移成正比', () => {
    expect(calcDragAngle(1, 0)).toBe(1)
    expect(calcDragAngle(0, 100)).toBeCloseTo(100 * DRAG_RAD_PER_PX)
    expect(calcDragAngle(1, -100)).toBeLessThan(1)
  })
  it('方向判定：位移不够或竖向占优不接管', () => {
    expect(isHorizontalIntent(DRAG_INTENT_PX - 1, 0)).toBe(false)
    expect(isHorizontalIntent(20, 30)).toBe(false)
    expect(isHorizontalIntent(-20, 5)).toBe(true)
  })
  it('惯性：速度衰减、角度增量同号、最终归零', () => {
    const s = calcInertiaStep(0.01, 16)
    expect(s.velocity).toBeGreaterThan(0)
    expect(s.velocity).toBeLessThan(0.01)
    expect(s.delta).toBeGreaterThan(0)
    expect(s.delta).toBeLessThan(0.01 * 16)
    expect(calcInertiaStep(-0.01, 16).delta).toBeLessThan(0)
    let v = 0.01
    for (let i = 0; i < 1000 && v !== 0; i++) v = calcInertiaStep(v, 33).velocity
    expect(v).toBe(0)
    expect(calcInertiaStep(INERTIA_STOP_SPEED * 1.01, 1000).velocity).toBe(0)
    expect(calcInertiaStep(0.01, 0)).toEqual({ delta: 0, velocity: 0.01 })
  })
  it('限幅与测速平滑', () => {
    expect(clampInertiaSpeed(1)).toBe(INERTIA_MAX_SPEED)
    expect(clampInertiaSpeed(-1)).toBe(-INERTIA_MAX_SPEED)
    expect(clampInertiaSpeed(0.001)).toBe(0.001)
    expect(smoothDragVelocity(0.5, 1, 0)).toBe(0.5)
    expect(smoothDragVelocity(0, 0.1, 10)).toBeGreaterThan(0)
    expect(smoothDragVelocity(0, 0.1, 10)).toBeLessThan(0.01)
  })
})

describe('ring-layout: 转速换算', () => {
  it('圈/秒、圈/分换算成弧度/毫秒', () => {
    expect(rpsToRadPerMs(1)).toBeCloseTo((Math.PI * 2) / 1000)
    expect(rpmToRadPerMs(1.5)).toBeCloseTo((Math.PI * 2) / 40000)
  })
  it('抽奖转速与时长折算整圈数，至少 2 圈', () => {
    expect(calcTargetRounds(1, 5000)).toBe(5)
    expect(calcTargetRounds(0.5, 3000)).toBe(2)
  })
  it('目标圈数可配置，其余环随之递减', () => {
    expect(calcRingMotion(1, 3, 1, 8).extraRounds).toBe(8)
    expect(calcRingMotion(0, 3, 1, 8).extraRounds).toBe(7)
  })
  it('自定义角速度参与匀速角度计算', () => {
    expect(calcSpinAngle(1000, 1, rpsToRadPerMs(2))).toBeCloseTo(Math.PI * 4)
  })
})
