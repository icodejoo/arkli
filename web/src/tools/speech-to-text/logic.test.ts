import { describe, expect, it } from 'vitest'
import {
  applySttFinal,
  applySttPartial,
  emptySttState,
  exportFileName,
  formatElapsed,
  isSttEmpty,
  settleStt,
  speechReadiness,
  transcriptText,
} from './logic'

describe('识别状态累积', () => {
  it('中间结果覆盖，定稿追加并清空中间结果', () => {
    let s = applySttPartial(emptySttState(), ' 你好 ')
    expect(s.partial).toBe('你好')
    s = applySttFinal(s, '你好。')
    expect(s).toEqual({ finals: ['你好。'], partial: '' })
  })
  it('空白定稿只清中间结果', () => {
    const s = applySttFinal({ finals: ['a'], partial: 'x' }, '  ')
    expect(s).toEqual({ finals: ['a'], partial: '' })
  })
  it('整段文本按中英文边界拼接', () => {
    expect(transcriptText({ finals: ['你好。', 'hello', 'world'], partial: '' })).toBe('你好。hello world')
    expect(transcriptText({ finals: ['你好。'], partial: '再见' })).toBe('你好。再见')
  })
  it('空状态判断', () => {
    expect(isSttEmpty(emptySttState())).toBe(true)
    expect(isSttEmpty({ finals: [], partial: '嗯' })).toBe(false)
  })
  it('收尾以整段为准；整段为空保留已有定稿', () => {
    expect(settleStt({ finals: ['a'], partial: 'b' }, '整段')).toEqual({ finals: ['整段'], partial: '' })
    expect(settleStt({ finals: ['a'], partial: 'b' }, ' ')).toEqual({ finals: ['a'], partial: '' })
  })
})

describe('可用性与格式', () => {
  it('没模型先提示下载，有模型看引擎', () => {
    expect(speechReadiness(false, true)).toBe('no-model')
    expect(speechReadiness(true, false)).toBe('unavailable')
    expect(speechReadiness(true, true)).toBe('ready')
  })
  it('导出文件名补零', () => {
    expect(exportFileName(new Date(2026, 0, 2, 3, 4, 5))).toBe('speech-20260102-030405.txt')
  })
  it('时长格式化', () => {
    expect(formatElapsed(65)).toBe('01:05')
    expect(formatElapsed(-3)).toBe('00:00')
  })
})
