import { describe, expect, it } from 'vitest'
import { indexAtAngle, MAX_SLICES, spinWheel, wheelGradient } from './logic'

describe('spinWheel', () => {
  it('停下时指针正好指向中选扇区', () => {
    for (let n = 2; n <= MAX_SLICES; n++) {
      for (let i = 0; i < 50; i++) {
        const r = spinWheel(n, 0)
        expect(indexAtAngle(r.angle, n)).toBe(r.index)
      }
    }
  })
  it('只往前转且至少转 4 圈', () => {
    const r1 = spinWheel(5, 0)
    const r2 = spinWheel(5, r1.angle)
    expect(r1.angle).toBeGreaterThanOrEqual(4 * 360)
    expect(r2.angle - r1.angle).toBeGreaterThanOrEqual(4 * 360)
  })
  it('扇区数越界抛错', () => {
    expect(() => spinWheel(1)).toThrow(RangeError)
    expect(() => spinWheel(13)).toThrow(RangeError)
  })
  it('各扇区被选中的概率均等', () => {
    const c = [0, 0, 0, 0]
    for (let i = 0; i < 8000; i++) c[spinWheel(4).index]++
    for (const n of c) expect(Math.abs(n - 2000)).toBeLessThan(250)
  })
})

describe('indexAtAngle', () => {
  it('零角度指向第 0 扇区，转半圈指向对面', () => {
    expect(indexAtAngle(0, 4)).toBe(0)
    expect(indexAtAngle(180, 4)).toBe(2)
  })
})

describe('wheelGradient', () => {
  it('按扇区数生成色段', () => {
    expect(wheelGradient(2)).toBe('conic-gradient(#c8553d 0deg 180deg, #b5651d 180deg 360deg)')
  })
})
