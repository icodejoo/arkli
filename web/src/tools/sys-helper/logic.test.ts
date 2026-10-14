import { describe, expect, it } from 'vitest'
import {
  ANIM_PRESETS,
  BATTERY_RESET_COMMAND,
  buildAnimationCommands,
  buildBatteryCommands,
  buildDpiCommands,
  buildSizeCommands,
  CALIBRATION_TIPS,
  estimateDensityDpi,
  isValidAnimScale,
  isValidBatteryLevel,
  isValidDpi,
  joinCommands,
  REBOOT_ITEMS,
  RESET_DISPLAY_COMMANDS,
  ROOT_REBOOT_NOTE,
} from './logic'

describe('estimateDensityDpi', () => {
  it('按 160 基准推算', () => {
    expect(estimateDensityDpi(2.75)).toBe(440)
    expect(estimateDensityDpi(3)).toBe(480)
  })
  it('非法值返回 0', () => {
    expect(estimateDensityDpi(0)).toBe(0)
    expect(estimateDensityDpi(NaN)).toBe(0)
  })
})

describe('范围校验', () => {
  it('DPI 120~960 的整数', () => {
    expect(isValidDpi(120)).toBe(true)
    expect(isValidDpi(960)).toBe(true)
    expect(isValidDpi(119)).toBe(false)
    expect(isValidDpi(961)).toBe(false)
    expect(isValidDpi(420.5)).toBe(false)
  })
  it('电量 0~100 的整数', () => {
    expect(isValidBatteryLevel(0)).toBe(true)
    expect(isValidBatteryLevel(100)).toBe(true)
    expect(isValidBatteryLevel(101)).toBe(false)
    expect(isValidBatteryLevel(-1)).toBe(false)
    expect(isValidBatteryLevel(5.5)).toBe(false)
  })
  it('动画倍数 0~10 可小数', () => {
    expect(isValidAnimScale(0)).toBe(true)
    expect(isValidAnimScale(0.5)).toBe(true)
    expect(isValidAnimScale(10)).toBe(true)
    expect(isValidAnimScale(10.1)).toBe(false)
    expect(isValidAnimScale(-0.1)).toBe(false)
    expect(isValidAnimScale(NaN)).toBe(false)
  })
})

describe('命令生成', () => {
  it('DPI', () => {
    expect(buildDpiCommands(420)).toEqual({ ok: true, commands: ['adb shell wm density 420'] })
    expect(buildDpiCommands(50).ok).toBe(false)
  })
  it('分辨率', () => {
    expect(buildSizeCommands(1080, 2400)).toEqual({ ok: true, commands: ['adb shell wm size 1080x2400'] })
    expect(buildSizeCommands(10, 2400).ok).toBe(false)
    expect(buildSizeCommands(1080.5, 2400).ok).toBe(false)
  })
  it('还原显示命令', () => {
    expect(RESET_DISPLAY_COMMANDS).toEqual(['adb shell wm density reset', 'adb shell wm size reset'])
  })
  it('电量伪装', () => {
    const r = buildBatteryCommands(30, 3, true)
    expect(r).toEqual({
      ok: true,
      commands: ['adb shell dumpsys battery set level 30', 'adb shell dumpsys battery set status 3', 'adb shell dumpsys battery set ac 1'],
    })
    expect(buildBatteryCommands(30, 3, false)).toMatchObject({ commands: expect.arrayContaining(['adb shell dumpsys battery set ac 0']) })
    expect(buildBatteryCommands(101, 3, false).ok).toBe(false)
    expect(buildBatteryCommands(50, 9, false).ok).toBe(false)
    expect(BATTERY_RESET_COMMAND).toBe('adb shell dumpsys battery reset')
  })
  it('动画速度生成三条', () => {
    const r = buildAnimationCommands(0.5)
    expect(r.ok && r.commands).toEqual([
      'adb shell settings put global window_animation_scale 0.5',
      'adb shell settings put global transition_animation_scale 0.5',
      'adb shell settings put global animator_duration_scale 0.5',
    ])
    expect(buildAnimationCommands(11).ok).toBe(false)
  })
  it('动画预设都合法', () => {
    expect(ANIM_PRESETS.every((p) => isValidAnimScale(p.value))).toBe(true)
  })
  it('joinCommands 以换行连接', () => {
    expect(joinCommands(['a', 'b'])).toBe('a\nb')
  })
})

describe('静态说明', () => {
  it('重启清单全是 adb reboot 命令', () => {
    expect(REBOOT_ITEMS.every((i) => i.adb.startsWith('adb reboot'))).toBe(true)
    expect(REBOOT_ITEMS.map((i) => i.adb)).toEqual(expect.arrayContaining(['adb reboot recovery', 'adb reboot bootloader', 'adb reboot fastboot', 'adb reboot sideload']))
  })
  it('root 说明与校准建议非空', () => {
    expect(ROOT_REBOOT_NOTE).toContain('root')
    expect(CALIBRATION_TIPS.length).toBeGreaterThan(0)
  })
})
