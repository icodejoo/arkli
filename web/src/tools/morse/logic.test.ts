import { describe, expect, it } from 'vitest'
import { buildTimeline, MORSE_TABLE, morseToText, textToMorse, timelineDuration, unitMs, WPM_MAX, WPM_MIN } from './logic'

describe('textToMorse', () => {
  it('SOS 与多个单词', () => {
    expect(textToMorse('SOS').morse).toBe('... --- ...')
    expect(textToMorse('hi  you').morse).toBe('.... .. / -.-- --- ..-')
  })
  it('数字与标点', () => {
    expect(textToMorse('1,?').morse).toBe('.---- --..-- ..--..')
  })
  it('不支持的字符被跳过并记录，中文单独标记', () => {
    const r = textToMorse('A中~中')
    expect(r.morse).toBe('.-')
    expect(r.unsupported).toEqual(['中', '~'])
    expect(r.hasChinese).toBe(true)
    expect(textToMorse('A~').hasChinese).toBe(false)
  })
  it('空输入得到空串', () => {
    expect(textToMorse('').morse).toBe('')
    expect(textToMorse('   ').morse).toBe('')
  })
})

describe('morseToText', () => {
  it('正常解码', () => {
    expect(morseToText('... --- ... / .-')).toEqual({ text: 'SOS A', unknown: [] })
  })
  it('兼容变体符号与多余空白', () => {
    expect(morseToText('·－  ·· ').text).toBe('AI')
    expect(morseToText('.-/-...').text).toBe('A B')
  })
  it('未知码用问号并记录', () => {
    expect(morseToText('.-.-.-.-.- .-')).toEqual({ text: '?A', unknown: ['.-.-.-.-.-'] })
  })
  it('空输入得到空串', () => {
    expect(morseToText('').text).toBe('')
  })
  it('码表往返所有字符', () => {
    for (const ch of Object.keys(MORSE_TABLE)) {
      expect(morseToText(textToMorse(ch).morse).text).toBe(ch)
    }
  })
})

describe('unitMs', () => {
  it('20 WPM 一个单位 60ms', () => {
    expect(unitMs(20)).toBe(60)
  })
  it('越界与非法值被截断', () => {
    expect(unitMs(1)).toBe(unitMs(WPM_MIN))
    expect(unitMs(999)).toBe(unitMs(WPM_MAX))
    expect(unitMs(NaN)).toBe(unitMs(WPM_MIN))
  })
})

describe('buildTimeline', () => {
  it('A（.-）：点 1、间隔 1、划 3 个单位', () => {
    const u = unitMs(20)
    expect(buildTimeline('.-', 20)).toEqual([
      { start: 0, duration: u, on: true },
      { start: u, duration: u, on: false },
      { start: 2 * u, duration: 3 * u, on: true },
    ])
  })
  it('字符间隔 3、单词间隔 7 个单位', () => {
    const u = unitMs(20)
    const t = buildTimeline('. . / .', 20)
    const gaps = t.filter((b) => !b.on).map((b) => b.duration / u)
    expect(gaps).toEqual([3, 7])
  })
  it('总时长符合 PARIS 标准：PARIS 加词间隔共 50 个单位', () => {
    const u = unitMs(20)
    const word = textToMorse('PARIS').morse
    const total = timelineDuration(buildTimeline(`${word} / ${word}`, 20))
    // 两个词 = 2*43 + 7 个单位
    expect(total / u).toBeCloseTo(93, 6)
  })
  it('空串与无效符号得到空时间线，末尾无静音', () => {
    expect(buildTimeline('', 20)).toEqual([])
    expect(buildTimeline(' / ', 20)).toEqual([])
    const t = buildTimeline('. /', 20)
    expect(t[t.length - 1].on).toBe(true)
  })
})

describe('timelineDuration', () => {
  it('空为 0，非空为末段结束时间', () => {
    expect(timelineDuration([])).toBe(0)
    expect(timelineDuration(buildTimeline('.', 20))).toBe(60)
  })
})
