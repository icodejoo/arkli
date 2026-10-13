import { describe, expect, it } from 'vitest'
import { intToUpper, moneyToUpper } from './logic'

/** 取成功文本，失败时返回错误文本便于断言 */
function t(s: string): string {
  const r = moneyToUpper(s)
  return r.ok ? r.text : 'ERR:' + r.error
}

describe('intToUpper', () => {
  it('零与个位', () => {
    expect(intToUpper(0n)).toBe('零')
    expect(intToUpper(7n)).toBe('柒')
  })
  it('组内零合并', () => {
    expect(intToUpper(1010n)).toBe('壹仟零壹拾')
    expect(intToUpper(1001n)).toBe('壹仟零壹')
    expect(intToUpper(100n)).toBe('壹佰')
  })
  it('跨组补零', () => {
    expect(intToUpper(100010n)).toBe('壹拾万零壹拾')
    expect(intToUpper(100000001n)).toBe('壹亿零壹')
    expect(intToUpper(100001000n)).toBe('壹亿零壹仟')
    expect(intToUpper(101000000n)).toBe('壹亿零壹佰万')
  })
  it('整组为零时只补一个零', () => {
    expect(intToUpper(1000000000n)).toBe('壹拾亿')
    expect(intToUpper(10000n)).toBe('壹万')
  })
  it('千亿上限', () => {
    expect(intToUpper(999999999999n)).toBe('玖仟玖佰玖拾玖亿玖仟玖佰玖拾玖万玖仟玖佰玖拾玖')
  })
})

describe('moneyToUpper', () => {
  it('设计文档样例', () => {
    expect(t('10.00')).toBe('壹拾元整')
    expect(t('100,010.05')).toBe('壹拾万零壹拾元零伍分')
    expect(t('0.5')).toBe('伍角')
    expect(t('1,000,000,000')).toBe('壹拾亿元整')
  })
  it('零与角分', () => {
    expect(t('0')).toBe('零元整')
    expect(t('0.00')).toBe('零元整')
    expect(t('0.05')).toBe('伍分')
    expect(t('0.55')).toBe('伍角伍分')
    expect(t('1.05')).toBe('壹元零伍分')
    expect(t('1.5')).toBe('壹元伍角')
  })
  it('负数', () => {
    expect(t('-12.3')).toBe('负壹拾贰元叁角')
    expect(t('-0')).toBe('零元整')
  })
  it('超过两位小数四舍五入', () => {
    expect(t('1.005')).toBe('壹元零壹分')
    expect(t('1.004')).toBe('壹元整')
    expect(t('0.999')).toBe('壹元整')
  })
  it('接受符号、空格与前导零', () => {
    expect(t(' ¥ 12 ')).toBe('壹拾贰元整')
    expect(t('007')).toBe('柒元整')
    expect(t('.5')).toBe('伍角')
  })
  it('上限与进位后越界', () => {
    expect(t('999999999999.99')).toContain('玖仟玖佰玖拾玖亿')
    expect(t('1000000000000')).toMatch(/^ERR:/)
    expect(t('999999999999.999')).toMatch(/^ERR:/)
  })
  it('非法输入给提示不抛错', () => {
    expect(t('')).toMatch(/^ERR:/)
    expect(t('abc')).toMatch(/^ERR:/)
    expect(t('1.2.3')).toMatch(/^ERR:/)
    expect(t('.')).toMatch(/^ERR:/)
    expect(t('1e5')).toMatch(/^ERR:/)
  })
})
