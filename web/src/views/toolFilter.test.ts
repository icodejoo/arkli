import { describe, expect, it } from 'vitest'
import type { ToolMeta } from '@/tools/registry'
import { DEFAULT_ICON, toolIcon } from './toolIcons'
import { filterTools } from './toolFilter'

/** 构造测试用工具 */
const mk = (id: string, name: string, description: string): ToolMeta => ({
  id,
  name,
  description,
  load: () => Promise.resolve({ default: {} }),
})

/** 测试数据 */
const LIST = [mk('a', '进制转换', '二进制十六进制'), mk('b', 'Base64 编解码', '文本互转')]

describe('filterTools', () => {
  it('空词返回全部', () => {
    expect(filterTools(LIST, '  ')).toHaveLength(2)
  })
  it('按名称或简介匹配且忽略大小写', () => {
    expect(filterTools(LIST, 'base').map((t) => t.id)).toEqual(['b'])
    expect(filterTools(LIST, '十六').map((t) => t.id)).toEqual(['a'])
  })
  it('无命中返回空', () => {
    expect(filterTools(LIST, 'zzz')).toEqual([])
  })
})

describe('toolIcon', () => {
  it('未登记用默认图标', () => {
    expect(toolIcon('nope')).toBe(DEFAULT_ICON)
    expect(toolIcon('dice')).not.toBe(DEFAULT_ICON)
  })
})
