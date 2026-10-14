import { describe, expect, it } from 'vitest'
import {
  animFrames,
  BLINK_OFF_CS,
  BLINK_ON_CS,
  captionLines,
  fitCaption,
  hitLayer,
  layerBox,
  layerFontPx,
  moveLayer,
  ratioSize,
  shakeAmplitude,
  shakeScale,
  strokeWidth,
  wrapText,
  type Measure,
  type TextLayer,
} from './logic'

/** 假测量：每个字符宽度 = 字号（全角） */
const full: Measure = (t, s) => t.length * s
/** 假测量：每个字符宽度 = 字号 × 0.6（拉丁字母） */
const latin: Measure = (t, s) => t.length * s * 0.6

/** 构造文字层 */
function layer(over: Partial<TextLayer> = {}): TextLayer {
  return { id: 1, text: 'ab', x: 0.5, y: 0.5, sizePct: 10, color: '#fff', strokeColor: '#000', strokePct: 10, ...over }
}

describe('wrapText', () => {
  it('中文逐字按宽度换行', () => {
    expect(wrapText('你好世界', 40, 20, full)).toEqual(['你好', '世界'])
  })
  it('英文单词不被拆开', () => {
    expect(wrapText('hello world', 100, 10, full)).toEqual(['hello', 'world'])
  })
  it('超宽的单词按字符拆开', () => {
    expect(wrapText('abcdefghij', 100, 20, full)).toEqual(['abcde', 'fghij'])
  })
  it('保留手动换行，空文本给一个空行', () => {
    expect(wrapText('a\nb', 100, 10, full)).toEqual(['a', 'b'])
    expect(wrapText('', 100, 10, full)).toEqual([''])
  })
  it('单字比宽度还大也不会死循环', () => {
    expect(wrapText('你好', 5, 20, full)).toEqual(['你', '好'])
  })
  it('行首不留空格', () => {
    expect(wrapText('aaaaa bbbbb', 50, 10, full)).toEqual(['aaaaa', 'bbbbb'])
  })
})

describe('fitCaption', () => {
  it('放得下时保持基础字号', () => {
    expect(fitCaption('HI', 200, { baseSize: 40, minSize: 10, maxLines: 3 }, latin)).toEqual({ size: 40, lines: ['HI'] })
  })
  it('一行放不下先缩小字号到刚好放下', () => {
    const r = fitCaption('HELLO', 100, { baseSize: 40, minSize: 10, maxLines: 3 }, latin)
    expect(r.lines).toEqual(['HELLO'])
    expect(r.size).toBe(33)
    expect(latin('HELLO', r.size)).toBeLessThanOrEqual(100)
    expect(latin('HELLO', r.size + 1)).toBeGreaterThan(100)
  })
  it('缩到单行下限仍放不下就换行，取行数不超限的最大字号', () => {
    const r = fitCaption('你好你好你好你好你好', 100, { baseSize: 40, minSize: 10, maxLines: 3 }, full)
    expect(r.size).toBe(25)
    expect(r.lines.length).toBe(3)
  })
  it('手动换行的每段各自成行', () => {
    const r = fitCaption('AB\nCD', 200, { baseSize: 40, minSize: 10, maxLines: 3 }, latin)
    expect(r.lines).toEqual(['AB', 'CD'])
  })
  it('怎么都放不下时用最小字号兜底', () => {
    const r = fitCaption('一二三四五六七八九十', 20, { baseSize: 40, minSize: 10, maxLines: 2 }, full)
    expect(r.size).toBe(10)
    expect(r.lines.length).toBeGreaterThan(2)
  })
})

describe('strokeWidth / layerFontPx', () => {
  it('描边约为字号 1/8，最少 2', () => {
    expect(strokeWidth(40)).toBe(5)
    expect(strokeWidth(8)).toBe(2)
  })
  it('文字层字号按画布宽度百分比', () => {
    expect(layerFontPx({ sizePct: 10 }, 400)).toBe(40)
    expect(layerFontPx({ sizePct: 0 }, 400)).toBe(1)
  })
})

describe('captionLines', () => {
  it('顶部字幕从上往下', () => {
    expect(captionLines(['A', 'B'], 20, 'top', 100)).toEqual([
      { text: 'A', y: 19 },
      { text: 'B', y: 43 },
    ])
  })
  it('底部字幕最后一行贴下边', () => {
    expect(captionLines(['A'], 20, 'bottom', 100)).toEqual([{ text: 'A', y: 81 }])
    const two = captionLines(['A', 'B'], 20, 'bottom', 100)
    expect(two.map((l) => l.y)).toEqual([57, 81])
  })
})

describe('layerBox / hitLayer / moveLayer', () => {
  it('文字层矩形以中心点对齐，多行取最宽行', () => {
    expect(layerBox(layer(), 200, 100, full)).toEqual({ left: 80, top: 38, width: 40, height: 24 })
    const b = layerBox(layer({ text: 'a\nabc' }), 200, 100, full)
    expect(b.width).toBe(60)
    expect(b.height).toBeCloseTo(48)
  })
  it('点选命中文字层，后面的层优先', () => {
    const layers = [layer({ id: 1 }), layer({ id: 2 })]
    expect(hitLayer(layers, 100, 50, 200, 100, full)).toBe(1)
  })
  it('命中范围外扩一点，远处未命中返回 -1', () => {
    const layers = [layer()]
    expect(hitLayer(layers, 75, 50, 200, 100, full)).toBe(0)
    expect(hitLayer(layers, 10, 5, 200, 100, full)).toBe(-1)
    expect(hitLayer([], 0, 0, 200, 100, full)).toBe(-1)
  })
  it('拖动换算成相对坐标并限制在画布内', () => {
    expect(moveLayer({ x: 0.5, y: 0.5 }, 20, -10, 200, 100)).toEqual({ x: 0.6, y: 0.4 })
    expect(moveLayer({ x: 0.5, y: 0.5 }, 500, 500, 200, 100)).toEqual({ x: 1, y: 1 })
    expect(moveLayer({ x: 0.1, y: 0.1 }, -500, -500, 200, 100)).toEqual({ x: 0, y: 0 })
  })
})

describe('动效帧参数', () => {
  it('抖动幅度随宽度变化，有下限', () => {
    expect(shakeAmplitude(400)).toBe(6)
    expect(shakeAmplitude(10)).toBe(2)
  })
  it('抖动放大倍数刚好盖住位移', () => {
    expect(shakeScale(100, 100, 2)).toBeCloseTo(1.04)
    expect(shakeScale(200, 100, 2)).toBeCloseTo(1.04)
  })
  it('抖动：8 帧、文字常显、位移围绕原点', () => {
    const f = animFrames('shake', 300)
    expect(f).toHaveLength(8)
    expect(f.every((x) => x.textVisible)).toBe(true)
    expect(f.reduce((s, x) => s + x.dx, 0)).toBe(0)
    expect(f.reduce((s, x) => s + x.dy, 0)).toBe(0)
    expect(Math.max(...f.map((x) => Math.abs(x.dx)))).toBe(shakeAmplitude(300))
  })
  it('闪烁：显示与隐藏交替，延迟不同', () => {
    const f = animFrames('blink', 300)
    expect(f.map((x) => x.textVisible)).toEqual([true, false])
    expect(f.map((x) => x.delayCs)).toEqual([BLINK_ON_CS, BLINK_OFF_CS])
    expect(f.every((x) => x.dx === 0 && x.dy === 0)).toBe(true)
  })
  it('无动效只有一帧', () => {
    expect(animFrames('none', 300)).toHaveLength(1)
  })
})

describe('ratioSize', () => {
  it('长边等于给定值', () => {
    expect(ratioSize(16, 9, 480)).toEqual({ width: 480, height: 270 })
    expect(ratioSize(9, 16, 480)).toEqual({ width: 270, height: 480 })
    expect(ratioSize(1, 1, 300)).toEqual({ width: 300, height: 300 })
  })
  it('比例非法时给正方形', () => {
    expect(ratioSize(0, 5, 200)).toEqual({ width: 200, height: 200 })
  })
})
