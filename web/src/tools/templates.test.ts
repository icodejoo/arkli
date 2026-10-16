import { describe, expect, it } from 'vitest'
import { compileTemplate, parse } from 'vue/compiler-sfc'

/** 所有工具页相关 vue 源码的原文，路径为 key */
const sources = import.meta.glob('/src/tools/**/*.vue', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

/** 底部动作栏的 vue 标签名，业务页用它承载主操作 */
const BAR_TAG = '<bottom-actions'

/**
 * 编译一个 vue 文件的模板，收集标签不配对等语法错误。
 *
 * @param path 文件路径，仅用于报错
 * @param src 文件原文
 * @returns 错误文案列表，空数组表示通过
 */
function templateErrors(path: string, src: string): string[] {
  const { descriptor, errors } = parse(src, { filename: path })
  const list: string[] = errors.map((e) => e.message)
  if (descriptor.template) {
    const res = compileTemplate({ source: descriptor.template.content, filename: path, id: path })
    list.push(...res.errors.map((e) => (typeof e === 'string' ? e : e.message)))
  }
  return list
}

describe('工具页模板守卫', () => {
  it('所有工具页的模板都能编译（标签配对、指令合法），避免批量改模板后漏掉闭合标签', () => {
    const bad = Object.entries(sources)
      .map(([path, src]) => [path, templateErrors(path, src)] as const)
      .filter(([, errs]) => errs.length > 0)
      .map(([path, errs]) => `${path}: ${errs.join(' | ')}`)
    expect(bad).toEqual([])
  })

  it('用了 <bottom-actions> 的页面必须显式 import BottomActions（它不在自动注册范围，漏了会被当成原生标签、整条栏不渲染）', () => {
    const bad = Object.entries(sources)
      .filter(([, src]) => src.includes(BAR_TAG) && !/import BottomActions from/.test(src))
      .map(([path]) => path)
    expect(bad).toEqual([])
  })

  it('底部动作栏里的模型选择器必须放在 #ai 插槽里，且用默认触发器', () => {
    const bad = Object.entries(sources)
      .filter(([, src]) => src.includes(BAR_TAG) && src.includes('<model-picker'))
      .filter(([, src]) => !/<template #ai>[\s\S]*?<model-picker/.test(src))
      .map(([path]) => path)
    expect(bad).toEqual([])
  })

  it('扫描确实覆盖到了工具页，且多数页面已接入底部动作栏（防止 glob 失效导致断言空转）', () => {
    const pages = Object.entries(sources).filter(([path]) => path.endsWith('/index.vue'))
    expect(pages.length).toBeGreaterThan(90)
    expect(pages.filter(([, src]) => src.includes(BAR_TAG)).length).toBeGreaterThan(50)
  })
})
