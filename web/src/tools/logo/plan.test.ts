// 品牌 Logo 方案生成逻辑的单元测试

import { describe, expect, it, vi } from 'vitest'
import {
  buildPlanPrompt,
  generatePlans,
  GROUP_NAMES,
  MAX_ATTEMPTS,
  parsePlansJson,
  PLAN_COUNT,
  planByKeywords,
  validatePlans,
} from './plan'
import { TEMPLATES } from './scene'
import { PALETTES } from './palettes'
import { FONTS } from './fonts'
import { ICON_DATA } from './assets/iconData'

/** 测试用常量：品牌名称 */
const TEST_BRAND_NAME = '测试品牌'
/** 测试用常量：品牌标语 */
const TEST_BRAND_SLOGAN = '好喝每一天'
/** 测试用常量：品牌描述 */
const TEST_BRAND_DESC = '专注于高品质精选咖啡'
/** 测试用常量：空文本 */
const TEST_EMPTY_STRING = ''
/** 测试用常量：未提供 */
const TEXT_NOT_PROVIDED = '未提供'
/** 测试用常量：来源 AI */
const SOURCE_AI = 'ai'
/** 测试用常量：来源规则 */
const SOURCE_RULES = 'rules'

/**
 * 校验方案列表中每个方案的图标键名是否存在于图标数据源中
 *
 * @param icon 图标名称
 * @returns 是否为有效图标键名
 * @example
 * ```ts
 * expect(isValidIconKey('coffee')).toBe(true)
 * ```
 */
function isValidIconKey(icon: string): boolean {
  return icon === TEST_EMPTY_STRING || Object.prototype.hasOwnProperty.call(ICON_DATA, icon)
}

describe('Logo 方案生成模块 plan', () => {
  describe('buildPlanPrompt', () => {
    it('生成的提示词必须包含品牌名与全部枚举标识', () => {
      const prompt = buildPlanPrompt({
        name: TEST_BRAND_NAME,
        slogan: TEST_BRAND_SLOGAN,
        desc: TEST_BRAND_DESC,
      })

      expect(prompt).toContain(TEST_BRAND_NAME)
      expect(prompt).toContain(TEST_BRAND_SLOGAN)
      expect(prompt).toContain(TEST_BRAND_DESC)

      for (const t of TEMPLATES) {
        expect(prompt).toContain(t.id)
      }
      for (const p of PALETTES) {
        expect(prompt).toContain(p.id)
      }
      for (const f of FONTS) {
        expect(prompt).toContain(f.id)
      }
      for (const groupKey of Object.keys(GROUP_NAMES)) {
        expect(prompt).toContain(groupKey)
      }
    })

    it('描述为空时填入未提供，传入上一次问题时在末尾追加修正说明', () => {
      const lastIssueText = '第 1 项的 template 不合法'
      const prompt = buildPlanPrompt(
        {
          name: TEST_BRAND_NAME,
          slogan: TEST_EMPTY_STRING,
          desc: TEST_EMPTY_STRING,
        },
        lastIssueText
      )

      expect(prompt).toContain(TEXT_NOT_PROVIDED)
      expect(prompt).toContain(`上一次的问题：${lastIssueText}`)
    })
  })

  describe('parsePlansJson', () => {
    it('支持标准纯 JSON 提取', () => {
      const text = '{"plans":[{"template":"badge-circle","palette":"tech-blue","group":"tech","font":"sans-bold"}]}'
      const parsed = parsePlansJson(text)
      expect(parsed).toEqual({
        plans: [
          { template: 'badge-circle', palette: 'tech-blue', group: 'tech', font: 'sans-bold' },
        ],
      })
    })

    it('容忍 markdown json 代码块与前后多余文本', () => {
      const text = '下面是为你生成的方案：\n```json\n{"plans":[]}\n```\n希望你满意。'
      const parsed = parsePlansJson(text)
      expect(parsed).toEqual({ plans: [] })
    })

    it('损坏的 JSON 或无大括号文本返回 null', () => {
      expect(parsePlansJson('{bad json}')).toBeNull()
      expect(parsePlansJson('毫无 JSON 内容')).toBeNull()
      expect(parsePlansJson(TEST_EMPTY_STRING)).toBeNull()
    })
  })

  describe('validatePlans', () => {
    it('正常校验合法方案', () => {
      const raw = {
        plans: [
          {
            template: 'badge-circle',
            palette: 'tech-blue',
            group: 'food',
            keyword: '咖啡',
            font: 'sans-bold',
          },
        ],
      }
      const res = validatePlans(raw)
      expect('plans' in res).toBe(true)
      if ('plans' in res) {
        expect(res.plans).toHaveLength(1)
        expect(res.plans[0].template).toBe('badge-circle')
        expect(res.plans[0].icon).toBe('coffee')
      }
    })

    it('缺少 plans 字段或不是非空数组时判定不合格', () => {
      expect(validatePlans({})).toHaveProperty('issue')
      expect(validatePlans({ plans: [] })).toHaveProperty('issue')
      expect(validatePlans({ plans: 'invalid' })).toHaveProperty('issue')
    })

    it('非法模板、配色、分组、字体返回对应中文 issue 说明', () => {
      const base = {
        template: 'badge-circle',
        palette: 'tech-blue',
        group: 'tech',
        font: 'sans-bold',
      }

      const resBadTemplate = validatePlans({ plans: [{ ...base, template: 'unknown-template' }] })
      expect(resBadTemplate).toHaveProperty('issue')
      if ('issue' in resBadTemplate) {
        expect(resBadTemplate.issue).toContain('template')
        expect(resBadTemplate.issue).toContain('unknown-template')
      }

      const resBadPalette = validatePlans({ plans: [{ ...base, palette: 'unknown-palette' }] })
      expect(resBadPalette).toHaveProperty('issue')
      if ('issue' in resBadPalette) {
        expect(resBadPalette.issue).toContain('palette')
        expect(resBadPalette.issue).toContain('unknown-palette')
      }

      const resBadGroup = validatePlans({ plans: [{ ...base, group: 'unknown-group' }] })
      expect(resBadGroup).toHaveProperty('issue')
      if ('issue' in resBadGroup) {
        expect(resBadGroup.issue).toContain('group')
        expect(resBadGroup.issue).toContain('unknown-group')
      }

      const resBadFont = validatePlans({ plans: [{ ...base, font: 'unknown-font' }] })
      expect(resBadFont).toHaveProperty('issue')
      if ('issue' in resBadFont) {
        expect(resBadFont.issue).toContain('font')
        expect(resBadFont.issue).toContain('unknown-font')
      }
    })

    it('多于 6 个方案自动截断到 6 个', () => {
      const raw = {
        plans: Array.from({ length: 8 }, (_, i) => ({
          template: TEMPLATES[i % TEMPLATES.length].id,
          palette: PALETTES[i % PALETTES.length].id,
          group: 'tech',
          font: FONTS[i % FONTS.length].id,
        })),
      }
      const res = validatePlans(raw)
      expect('plans' in res).toBe(true)
      if ('plans' in res) {
        expect(res.plans).toHaveLength(PLAN_COUNT)
      }
    })

    it('keyword 命中图标测试以及未提供 keyword 时按索引轮转选不同图标', () => {
      const raw = {
        plans: [
          {
            template: 'badge-circle',
            palette: 'tech-blue',
            group: 'food',
            keyword: '咖啡',
            font: 'sans-bold',
          },
          {
            template: 'square-round',
            palette: 'coral-sand',
            group: 'food',
            keyword: TEST_EMPTY_STRING,
            font: 'sans',
          },
          {
            template: 'shield',
            palette: 'fresh-mint',
            group: 'food',
            keyword: TEST_EMPTY_STRING,
            font: 'mono',
          },
        ],
      }
      const res = validatePlans(raw)
      expect('plans' in res).toBe(true)
      if ('plans' in res) {
        expect(res.plans[0].icon).toBe('coffee')
        // 未提供 keyword 时方案 1 与方案 2 应按索引选取不同图标
        expect(res.plans[1].icon).not.toBe(res.plans[2].icon)
      }
    })

    it('完全重复的方案去重后保留一份', () => {
      const duplicateItem = {
        template: 'badge-circle',
        palette: 'tech-blue',
        group: 'food',
        keyword: '咖啡',
        font: 'sans-bold',
      }
      const raw = {
        plans: [duplicateItem, duplicateItem, duplicateItem],
      }
      const res = validatePlans(raw)
      expect('plans' in res).toBe(true)
      if ('plans' in res) {
        expect(res.plans).toHaveLength(1)
      }
    })
  })

  describe('planByKeywords', () => {
    const testCases: Array<{ name: string; slogan: string; desc: string }> = [
      { name: '咖啡店', slogan: '浓香每一杯', desc: '手冲与拿铁' },
      { name: '宠物医院', slogan: '呵护萌宠健康', desc: '专业宠物医疗诊所' },
      { name: '程序员工作室', slogan: '代码改变世界', desc: '全栈软件开发' },
      { name: TEST_EMPTY_STRING, slogan: TEST_EMPTY_STRING, desc: TEST_EMPTY_STRING },
    ]

    it.each(testCases)('针对 "$name" 输入恒返回 6 个互不相同且稳定的方案', (req) => {
      const plans1 = planByKeywords(req)
      const plans2 = planByKeywords(req)

      expect(plans1).toHaveLength(PLAN_COUNT)
      expect(plans1).toEqual(plans2)

      const keys = new Set(plans1.map(p => `${p.template}___${p.palette}___${p.icon}`))
      expect(keys.size).toBe(PLAN_COUNT)

      for (const p of plans1) {
        expect(isValidIconKey(p.icon)).toBe(true)
      }
    })
  })

  describe('generatePlans', () => {
    it('首次调用即成功返回 AI 结果', async () => {
      const mockReply = JSON.stringify({
        plans: Array.from({ length: 6 }, (_, i) => ({
          template: TEMPLATES[i].id,
          palette: PALETTES[i].id,
          group: 'tech',
          font: FONTS[i].id,
        })),
      })

      const runMock = vi.fn().mockResolvedValue(mockReply)
      const result = await generatePlans(
        { name: TEST_BRAND_NAME, slogan: TEST_EMPTY_STRING, desc: TEST_EMPTY_STRING },
        runMock
      )

      expect(runMock).toHaveBeenCalledTimes(1)
      expect(result.source).toBe(SOURCE_AI)
      expect(result.attempts).toBe(1)
      expect(result.plans).toHaveLength(PLAN_COUNT)
    })

    it('首次非法第二次成功重试两次且第二次携带上次错误', async () => {
      const badReply = '{"plans":[{"template":"invalid","palette":"tech-blue","group":"tech","font":"sans"}]}'
      const goodReply = JSON.stringify({
        plans: Array.from({ length: 6 }, (_, i) => ({
          template: TEMPLATES[i].id,
          palette: PALETTES[i].id,
          group: 'food',
          font: FONTS[i].id,
        })),
      })

      const runMock = vi.fn().mockImplementation((prompt: string, attempt: number) => {
        if (attempt === 1) return Promise.resolve(badReply)
        return Promise.resolve(goodReply)
      })

      const result = await generatePlans(
        { name: TEST_BRAND_NAME, slogan: TEST_EMPTY_STRING, desc: TEST_EMPTY_STRING },
        runMock
      )

      expect(runMock).toHaveBeenCalledTimes(2)
      expect(result.source).toBe(SOURCE_AI)
      expect(result.attempts).toBe(2)
      expect(result.plans).toHaveLength(PLAN_COUNT)

      const secondPrompt = runMock.mock.calls[1][0]
      expect(secondPrompt).toContain('上一次的问题')
    })

    it('两次尝试均非法时回退到规则生成并标记 source 为 rules', async () => {
      const badReply = '{"plans":[]}'
      const runMock = vi.fn().mockResolvedValue(badReply)

      const result = await generatePlans(
        { name: TEST_BRAND_NAME, slogan: TEST_EMPTY_STRING, desc: TEST_EMPTY_STRING },
        runMock
      )

      expect(runMock).toHaveBeenCalledTimes(MAX_ATTEMPTS)
      expect(result.source).toBe(SOURCE_RULES)
      expect(result.attempts).toBe(MAX_ATTEMPTS)
      expect(result.plans).toHaveLength(PLAN_COUNT)
      expect(result.note).toBeDefined()
    })

    it('run 自行抛错时直接向上抛出', async () => {
      const runMock = vi.fn().mockRejectedValue(new Error('网络连接超时'))

      await expect(
        generatePlans(
          { name: TEST_BRAND_NAME, slogan: TEST_EMPTY_STRING, desc: TEST_EMPTY_STRING },
          runMock
        )
      ).rejects.toThrow('网络连接超时')
    })

    it('AI 返回少于 6 个方案时自动用规则补足到 6 个且互不重复', async () => {
      const partialReply = JSON.stringify({
        plans: [
          {
            template: TEMPLATES[0].id,
            palette: PALETTES[0].id,
            group: 'tech',
            font: FONTS[0].id,
          },
        ],
      })

      const runMock = vi.fn().mockResolvedValue(partialReply)
      const result = await generatePlans(
        { name: TEST_BRAND_NAME, slogan: TEST_EMPTY_STRING, desc: TEST_EMPTY_STRING },
        runMock
      )

      expect(runMock).toHaveBeenCalledTimes(1)
      expect(result.source).toBe(SOURCE_AI)
      expect(result.attempts).toBe(1)
      expect(result.plans).toHaveLength(PLAN_COUNT)

      const uniqueKeys = new Set(result.plans.map(p => `${p.template}___${p.palette}___${p.icon}`))
      expect(uniqueKeys.size).toBe(PLAN_COUNT)
    })
  })
})
