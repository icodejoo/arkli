import { describe, expect, it } from 'vitest'
import { MAX_CHAIN, calcKinship, chainToText, type Gender, type Step } from './logic'

/** 取称呼列表，失败返回 ERR:提示 */
function k(chain: Step[], me: Gender = 'm'): string[] | string {
  const r = calcKinship(chain, me)
  return r.ok ? r.titles : 'ERR:' + r.error
}

describe('chainToText', () => {
  it('拼接与空链', () => {
    expect(chainToText(['f', 'ob', 's'])).toBe('爸爸的哥哥的儿子')
    expect(chainToText([])).toBe('我')
  })
})

describe('直系与祖辈', () => {
  it('基本关系', () => {
    expect(k(['f'])).toEqual(['爸爸'])
    expect(k(['m', 'm'])).toEqual(['外婆'])
    expect(k(['f', 'f'])).toEqual(['爷爷'])
    expect(k(['m', 'f'])).toEqual(['外公'])
    expect(k(['f', 'f', 'm'])).toEqual(['曾祖母'])
    expect(k([])).toEqual(['自己'])
  })
})

describe('父母的同胞与堂表亲', () => {
  it('伯叔姑舅姨', () => {
    expect(k(['f', 'ob'])).toEqual(['伯父'])
    expect(k(['f', 'lb'])).toEqual(['叔叔'])
    expect(k(['f', 'os'])).toEqual(['姑妈'])
    expect(k(['m', 'ob'])).toEqual(['舅舅'])
    expect(k(['m', 'ls'])).toEqual(['姨妈', '小姨'])
    expect(k(['f', 'lb', 'w'])).toEqual(['婶婶'])
    expect(k(['m', 'os', 'h'])).toEqual(['姨父'])
  })
  it('堂表亲年龄不明时列出两个', () => {
    expect(k(['f', 'ob', 's'])).toEqual(['堂哥', '堂弟'])
    expect(k(['f', 'os', 'd'])).toEqual(['表姐', '表妹'])
    expect(k(['m', 'ob', 's'])).toEqual(['表哥', '表弟'])
  })
})

describe('配偶方与同胞方', () => {
  it('岳家婆家', () => {
    expect(k(['w', 'f'])).toEqual(['岳父'])
    expect(k(['w', 'm'])).toEqual(['岳母'])
    expect(k(['h', 'f'], 'f')).toEqual(['公公'])
    expect(k(['h', 'ob'], 'f')).toEqual(['大伯子'])
    expect(k(['w', 'ls'])).toEqual(['小姨子'])
  })
  it('同胞的家庭', () => {
    expect(k(['ob', 'w'])).toEqual(['嫂子'])
    expect(k(['os', 'h'])).toEqual(['姐夫'])
    expect(k(['ob', 's'])).toEqual(['侄子'])
    expect(k(['os', 'd'])).toEqual(['外甥女'])
  })
})

describe('晚辈', () => {
  it('子孙', () => {
    expect(k(['s', 'w'])).toEqual(['儿媳'])
    expect(k(['d', 'h'])).toEqual(['女婿'])
    expect(k(['s', 's'])).toEqual(['孙子'])
    expect(k(['d', 'd'])).toEqual(['外孙女'])
    expect(k(['s', 'w', 'f'])).toEqual(['亲家公'])
  })
})

describe('化简规则', () => {
  it('妻子的丈夫是自己', () => {
    expect(k(['w', 'h'])).toEqual(['自己'])
  })
  it('爸爸的妻子是妈妈，妈妈的丈夫是爸爸', () => {
    expect(k(['f', 'w'])).toEqual(['妈妈'])
    expect(k(['m', 'h'])).toEqual(['爸爸'])
  })
  it('爸爸的儿子：男性可能是自己，都可能是兄弟', () => {
    expect(k(['f', 's'], 'm')).toEqual(['哥哥', '弟弟', '自己'])
    expect(k(['f', 's'], 'f')).toEqual(['哥哥', '弟弟'])
  })
  it('妈妈的女儿：女性可能是自己', () => {
    expect(k(['m', 'd'], 'f')).toEqual(['姐姐', '妹妹', '自己'])
  })
  it('爸爸的儿子的儿子 = 侄子或自己的儿子', () => {
    expect(k(['f', 's', 's'], 'm')).toEqual(['侄子', '儿子'])
  })
  it('哥哥的姐姐还是姐姐，弟弟的妹妹还是妹妹', () => {
    expect(k(['ob', 'os'])).toEqual(['姐姐'])
    expect(k(['lb', 'ls'])).toEqual(['妹妹'])
  })
  it('同胞的爸妈就是我的爸妈', () => {
    expect(k(['ob', 'f'])).toEqual(['爸爸'])
    expect(k(['ls', 'm'])).toEqual(['妈妈'])
  })
  it('儿子的妈妈：男性是妻子，女性是自己', () => {
    expect(k(['s', 'm'], 'm')).toEqual(['妻子'])
    expect(k(['s', 'm'], 'f')).toEqual(['自己'])
  })
  it('妻子的儿子化简为儿子', () => {
    expect(k(['w', 's'])).toEqual(['儿子'])
  })
})

describe('异常输入', () => {
  it('性别不自洽', () => {
    expect(k(['w'], 'f')).toMatch(/^ERR:/)
    expect(k(['h'], 'm')).toMatch(/^ERR:/)
    expect(k(['f', 'h'], 'm')).toMatch(/^ERR:/)
    expect(k(['os', 'w'], 'm')).toMatch(/^ERR:/)
  })
  it('超长链', () => {
    expect(k(Array<Step>(MAX_CHAIN + 1).fill('f'))).toMatch(/^ERR:/)
  })
  it('表里没有的关系给提示而不抛错', () => {
    expect(k(['f', 'f', 'f', 'f', 'f'])).toMatch(/^ERR:/)
  })
})
