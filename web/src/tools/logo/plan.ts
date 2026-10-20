// 品牌 Logo 方案生成逻辑：结合行业关键词、风格标签、枚举规则或大模型生成方案

import type { FontId, TemplateId } from './types'
import { PALETTES } from './palettes'
import { FONTS } from './fonts'
import { TEMPLATES } from './scene'
import { ICON_DATA, type IconGroup } from './assets/iconData'

/** 期望生成的方案数量 */
export const PLAN_COUNT = 6

/** 大模型最大重试调用次数 */
export const MAX_ATTEMPTS = 2

/** 图标分组中文映射表 */
export const GROUP_NAMES: Record<IconGroup, string> = {
  food: '餐饮咖啡',
  tech: '科技数码',
  edu: '教育学术',
  health: '医疗健康',
  retail: '零售电商',
  travel: '旅游户外',
  nature: '农业环保',
  pet: '宠物萌宠',
  finance: '金融商贸',
  sport: '运动健身',
  art: '文化艺术',
  beauty: '美妆丽人',
  home: '家居房产',
  auto: '汽车出行',
  general: '通用综合',
}

/** Logo 方案配置接口 */
export interface LogoPlan {
  /** 模板唯一标识 */
  template: TemplateId
  /** 配色方案唯一标识 */
  palette: string
  /** 图标名称，取自 ICON_DATA 的 key，可为空字符串 */
  icon: string
  /** 字体唯一标识 */
  font: FontId
}

/** 生成方案请求参数接口 */
export interface PlanRequest {
  /** 品牌名称 */
  name: string
  /** 标语，可为空 */
  slogan: string
  /** 一句话描述，可为空 */
  desc: string
}

/** 生成方案结果接口 */
export interface GeneratePlansResult {
  /** 方案列表（最多 6 个） */
  plans: LogoPlan[]
  /** 生成来源：ai 表示模型生成，rules 表示规则兜底 */
  source: 'ai' | 'rules'
  /** 尝试次数 */
  attempts: number
  /** 失败或补充说明备注 */
  note?: string
}

/** 调模型的函数类型定义 */
export type RunPrompt = (prompt: string, attempt: number) => Promise<string>

// 重复字符串及通用常量提取
const SOURCE_AI = 'ai'
const SOURCE_RULES = 'rules'
const FIELD_PLANS = 'plans'
const FIELD_TEMPLATE = 'template'
const FIELD_PALETTE = 'palette'
const FIELD_GROUP = 'group'
const FIELD_FONT = 'font'
const FIELD_KEYWORD = 'keyword'
const GROUP_GENERAL: IconGroup = 'general'
const NOT_PROVIDED = '未提供'
const SEPARATOR = '___'
const EMPTY_STRING = ''

const MSG_MISSING_PLANS = '缺少 plans 字段'
const MSG_PLANS_NON_EMPTY_ARRAY = 'plans 必须为非空数组'
const MSG_PLANS_EMPTY_AFTER_DEDUP = '去重后方案为空'
const MSG_UNABLE_PARSE_JSON = '未能从输出中提取到合法 JSON 对象'
const MSG_DEFAULT_FALLBACK = '未能生成符合要求的 Logo 方案'

/** 行业词到分组映射项接口 */
interface IndustryWordItem {
  /** 匹配关键词 */
  word: string
  /** 目标分组 */
  group: IconGroup
}

/** 行业关键词到图标分组的映射表 */
const INDUSTRY_WORDS: ReadonlyArray<IndustryWordItem> = [
  // 餐饮咖啡
  { word: '咖啡', group: 'food' },
  { word: '茶', group: 'food' },
  { word: '奶茶', group: 'food' },
  { word: '餐饮', group: 'food' },
  { word: '甜点', group: 'food' },
  { word: '蛋糕', group: 'food' },
  { word: '面包', group: 'food' },
  { word: '餐厅', group: 'food' },
  { word: '美食', group: 'food' },
  { word: '快餐', group: 'food' },
  // 科技数码
  { word: '程序', group: 'tech' },
  { word: '软件', group: 'tech' },
  { word: '科技', group: 'tech' },
  { word: 'ai', group: 'tech' },
  { word: '芯片', group: 'tech' },
  { word: '代码', group: 'tech' },
  { word: '开发', group: 'tech' },
  { word: '算法', group: 'tech' },
  { word: '智能', group: 'tech' },
  // 教育学术
  { word: '学校', group: 'edu' },
  { word: '培训', group: 'edu' },
  { word: '教育', group: 'edu' },
  { word: '学院', group: 'edu' },
  { word: '课程', group: 'edu' },
  { word: '学习', group: 'edu' },
  // 医疗健康
  { word: '医院', group: 'health' },
  { word: '诊所', group: 'health' },
  { word: '健康', group: 'health' },
  { word: '医疗', group: 'health' },
  { word: '药', group: 'health' },
  { word: '护理', group: 'health' },
  // 农业环保
  { word: '花店', group: 'nature' },
  { word: '农场', group: 'nature' },
  { word: '绿色', group: 'nature' },
  { word: '农业', group: 'nature' },
  { word: '环保', group: 'nature' },
  { word: '植物', group: 'nature' },
  // 宠物萌宠
  { word: '宠物', group: 'pet' },
  { word: '猫', group: 'pet' },
  { word: '狗', group: 'pet' },
  { word: '萌宠', group: 'pet' },
  { word: '动物', group: 'pet' },
  // 金融商贸
  { word: '律所', group: 'finance' },
  { word: '银行', group: 'finance' },
  { word: '理财', group: 'finance' },
  { word: '金融', group: 'finance' },
  { word: '投资', group: 'finance' },
  { word: '证券', group: 'finance' },
  // 运动健身
  { word: '健身', group: 'sport' },
  { word: '运动', group: 'sport' },
  { word: '体育', group: 'sport' },
  { word: '瑜伽', group: 'sport' },
  // 文化艺术
  { word: '摄影', group: 'art' },
  { word: '音乐', group: 'art' },
  { word: '设计', group: 'art' },
  { word: '艺术', group: 'art' },
  // 美妆丽人
  { word: '美容', group: 'beauty' },
  { word: '美发', group: 'beauty' },
  { word: '美妆', group: 'beauty' },
  { word: '护肤', group: 'beauty' },
  // 家居房产
  { word: '装修', group: 'home' },
  { word: '家居', group: 'home' },
  { word: '房产', group: 'home' },
  { word: '建材', group: 'home' },
  // 汽车物流
  { word: '汽车', group: 'auto' },
  { word: '物流', group: 'auto' },
  { word: '运输', group: 'auto' },
  { word: '出行', group: 'auto' },
  // 零售电商
  { word: '超市', group: 'retail' },
  { word: '商场', group: 'retail' },
  { word: '购物', group: 'retail' },
  { word: '电商', group: 'retail' },
  // 旅游户外
  { word: '旅游', group: 'travel' },
  { word: '旅行', group: 'travel' },
  { word: '酒店', group: 'travel' },
  { word: '景区', group: 'travel' },
]

/** 风格词到配色标签映射项接口 */
interface StyleTagItem {
  /** 匹配关键词 */
  word: string
  /** 风格标签 */
  tag: string
}

/** 风格关键词到配色标签的映射表 */
const STYLE_TAGS: ReadonlyArray<StyleTagItem> = [
  { word: '沉稳', tag: 'calm' },
  { word: '商务', tag: 'calm' },
  { word: '稳重', tag: 'calm' },
  { word: '活泼', tag: 'vivid' },
  { word: '年轻', tag: 'vivid' },
  { word: '活力', tag: 'vivid' },
  { word: '高端', tag: 'elegant' },
  { word: '奢华', tag: 'elegant' },
  { word: '尊贵', tag: 'elegant' },
  { word: '自然', tag: 'natural' },
  { word: '清新', tag: 'natural' },
  { word: '暖', tag: 'warm' },
  { word: '温馨', tag: 'warm' },
  { word: '科技', tag: 'cool' },
  { word: '冷', tag: 'cool' },
  { word: '夜', tag: 'dark' },
  { word: '酷', tag: 'dark' },
]

/**
 * 针对字符串计算确定性的整型哈希值
 *
 * @param text 输入文本内容
 * @returns 非负整型哈希值
 */
function hashText(text: string): number {
  let h = 0
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

/** 按图标分组缓存图标条目 */
const ICONS_BY_GROUP: Record<IconGroup, Array<[string, (typeof ICON_DATA)[string]]>> = (() => {
  const map: Record<IconGroup, Array<[string, (typeof ICON_DATA)[string]]>> = {
    food: [],
    tech: [],
    edu: [],
    health: [],
    retail: [],
    travel: [],
    nature: [],
    pet: [],
    finance: [],
    sport: [],
    art: [],
    beauty: [],
    home: [],
    auto: [],
    general: [],
  }
  for (const entry of Object.entries(ICON_DATA)) {
    const group = entry[1].g
    if (map[group]) {
      map[group].push(entry)
    }
  }
  return map
})()

/** 合法模板集合 */
const VALID_TEMPLATES = new Set<string>(TEMPLATES.map(t => t.id))
/** 合法配色集合 */
const VALID_PALETTES = new Set<string>(PALETTES.map(p => p.id))
/** 合法字体集合 */
const VALID_FONTS = new Set<string>(FONTS.map(f => f.id))
/** 合法分组集合 */
const VALID_GROUPS = new Set<string>(Object.keys(GROUP_NAMES))

/**
 * 构建大模型生成 Logo 方案的提示词
 *
 * @param req 方案生成请求参数
 * @param lastIssue 上一次生成不合格的原因，存在时追加修正指导
 * @returns 组合后的完整中文提示词
 * @example
 * ```ts
 * const prompt = buildPlanPrompt({ name: '星空咖啡', slogan: '品味静谧', desc: '手冲咖啡馆' })
 * ```
 */
export function buildPlanPrompt(req: PlanRequest, lastIssue?: string): string {
  const nameText = req.name.trim() || NOT_PROVIDED
  const sloganText = req.slogan.trim() || NOT_PROVIDED
  const descText = req.desc.trim() || NOT_PROVIDED

  const templatesList = TEMPLATES.map(t => `${t.id}(${t.name})`).join(', ')
  const palettesList = PALETTES.map(p => `${p.id}(${p.name}: ${p.tags.join('/')})`).join(', ')
  const groupsList = Object.entries(GROUP_NAMES).map(([id, name]) => `${id}(${name})`).join(', ')
  const fontsList = FONTS.map(f => `${f.id}(${f.name})`).join(', ')

  const lines = [
    '你是一名专业的品牌 Logo 设计专家。请根据品牌信息，设计恰好 6 个风格互不相同的 Logo 方案。',
    '',
    '【品牌信息】',
    `- 品牌名：${nameText}`,
    `- 标语：${sloganText}`,
    `- 描述：${descText}`,
    '',
    '【可选枚举列表】',
    `- 模板（template）：${templatesList}`,
    `- 配色（palette）：${palettesList}`,
    `- 图标分组（group）：${groupsList}`,
    `- 字体（font）：${fontsList}`,
    '',
    '【输出格式与规则】',
    '1. 只能输出纯 JSON 对象，不要输出任何前言、解释、markdown 标记或多余文字。',
    '2. 格式严格如下：{"plans":[{"template":"<模板id>","palette":"<配色id>","group":"<分组id>","keyword":"<一个中文关键词，可空>","font":"<字体id>"}, ...]}',
    '3. plans 数组必须恰好包含 6 个方案，彼此在模板、配色、图标分组及字体上尽量不同，风格多样。',
    '4. keyword 为在该分组中检索图标的中文关键词（1-4字），找不到匹配时会使用同组图标兜底。',
  ]

  if (lastIssue) {
    lines.push(`上一次的问题：${lastIssue}，请严格按格式重写。`)
  }

  return lines.join('\n')
}

/**
 * 从模型输出文本中提取并解析第一个 JSON 对象
 *
 * @param text 模型返回的原始文本
 * @returns 解析得到的对象；若解析失败则返回 null
 * @example
 * ```ts
 * const data = parsePlansJson('```json\n{"plans":[]}\n```')
 * ```
 */
export function parsePlansJson(text: string): unknown {
  if (!text) return null
  const clean = text.replace(/```(?:json)?/gi, EMPTY_STRING).replace(/```/g, EMPTY_STRING)
  const firstBrace = clean.indexOf('{')
  if (firstBrace === -1) return null

  let depth = 0
  let inString = false
  let escape = false
  let matchEnd = -1

  for (let i = firstBrace; i < clean.length; i++) {
    const ch = clean[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\' && inString) {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (!inString) {
      if (ch === '{') {
        depth++
      } else if (ch === '}') {
        depth--
        if (depth === 0) {
          matchEnd = i
          break
        }
      }
    }
  }

  if (matchEnd !== -1) {
    try {
      const candidate = clean.slice(firstBrace, matchEnd + 1)
      return JSON.parse(candidate)
    } catch {
      // 括号匹配提取解析失败时尝试备用兜底逻辑
    }
  }

  const lastBrace = clean.lastIndexOf('}')
  if (lastBrace > firstBrace) {
    try {
      return JSON.parse(clean.slice(firstBrace, lastBrace + 1))
    } catch {
      return null
    }
  }

  return null
}

/**
 * 严格校验模型解析出的方案结构并映射图标
 *
 * @param raw 待校验的原始数据对象
 * @returns 校验成功返回方案列表，失败返回中文问题说明
 * @example
 * ```ts
 * const res = validatePlans({ plans: [{ template: 'badge-circle', palette: 'tech-blue', group: 'tech', font: 'sans-bold' }] })
 * ```
 */
export function validatePlans(raw: unknown): { plans: LogoPlan[] } | { issue: string } {
  if (!raw || typeof raw !== 'object' || !(FIELD_PLANS in raw)) {
    return { issue: MSG_MISSING_PLANS }
  }
  const rawPlans = (raw as Record<string, unknown>)[FIELD_PLANS]
  if (!Array.isArray(rawPlans) || rawPlans.length === 0) {
    return { issue: MSG_PLANS_NON_EMPTY_ARRAY }
  }

  const sliced = rawPlans.slice(0, PLAN_COUNT)
  const resolvedPlans: LogoPlan[] = []

  for (let i = 0; i < sliced.length; i++) {
    const item = sliced[i]
    if (!item || typeof item !== 'object') {
      return { issue: `第 ${i + 1} 个方案不是有效对象` }
    }
    const p = item as Record<string, unknown>
    const template = p[FIELD_TEMPLATE]
    if (typeof template !== 'string' || !VALID_TEMPLATES.has(template)) {
      return { issue: `第 ${i + 1} 项的 template '${String(template)}' 不合法` }
    }
    const palette = p[FIELD_PALETTE]
    if (typeof palette !== 'string' || !VALID_PALETTES.has(palette)) {
      return { issue: `第 ${i + 1} 项的 palette '${String(palette)}' 不合法` }
    }
    const group = p[FIELD_GROUP]
    if (typeof group !== 'string' || !VALID_GROUPS.has(group)) {
      return { issue: `第 ${i + 1} 项的 group '${String(group)}' 不合法` }
    }
    const font = p[FIELD_FONT]
    if (typeof font !== 'string' || !VALID_FONTS.has(font)) {
      return { issue: `第 ${i + 1} 项的 font '${String(font)}' 不合法` }
    }

    const groupIcons = ICONS_BY_GROUP[group as IconGroup] || []
    let selectedIcon = EMPTY_STRING
    if (groupIcons.length > 0) {
      const kw = typeof p[FIELD_KEYWORD] === 'string' ? (p[FIELD_KEYWORD] as string).trim() : EMPTY_STRING
      if (kw) {
        const found = groupIcons.find(([, data]) =>
          data.k.some(k => k.includes(kw) || kw.includes(k))
        )
        if (found) {
          selectedIcon = found[0]
        }
      }
      if (!selectedIcon) {
        selectedIcon = groupIcons[i % groupIcons.length][0]
      }
    }

    resolvedPlans.push({
      template: template as TemplateId,
      palette,
      icon: selectedIcon,
      font: font as FontId,
    })
  }

  const seen = new Set<string>()
  const uniquePlans: LogoPlan[] = []
  for (const plan of resolvedPlans) {
    const key = `${plan.template}${SEPARATOR}${plan.palette}${SEPARATOR}${plan.icon}`
    if (!seen.has(key)) {
      seen.add(key)
      uniquePlans.push(plan)
    }
  }

  if (uniquePlans.length === 0) {
    return { issue: MSG_PLANS_EMPTY_AFTER_DEDUP }
  }

  return { plans: uniquePlans }
}

/**
 * 依据品牌关键词与规则稳定生成 6 个互不重复的方案
 *
 * @param req 方案生成请求参数
 * @returns 确定的 6 个方案配置列表
 * @example
 * ```ts
 * const plans = planByKeywords({ name: '星空咖啡', slogan: '', desc: '' })
 * ```
 */
export function planByKeywords(req: PlanRequest): LogoPlan[] {
  const fullText = `${req.name ?? EMPTY_STRING}${req.slogan ?? EMPTY_STRING}${req.desc ?? EMPTY_STRING}`.trim().toLowerCase()
  const seed = hashText(fullText)

  const matchedIconKeys: string[] = []
  if (fullText) {
    for (const [key, data] of Object.entries(ICON_DATA)) {
      if (data.k.some(kw => fullText.includes(kw.toLowerCase()))) {
        matchedIconKeys.push(key)
      }
    }
  }

  let iconPool: string[] = []
  if (matchedIconKeys.length > 0) {
    iconPool = matchedIconKeys
  } else if (fullText) {
    const matchedGroups = new Set<IconGroup>()
    for (const item of INDUSTRY_WORDS) {
      if (fullText.includes(item.word.toLowerCase())) {
        matchedGroups.add(item.group)
      }
    }
    if (matchedGroups.size > 0) {
      for (const group of matchedGroups) {
        const icons = ICONS_BY_GROUP[group] || []
        for (const [k] of icons) {
          iconPool.push(k)
        }
      }
    }
  }

  if (iconPool.length === 0) {
    iconPool = (ICONS_BY_GROUP[GROUP_GENERAL] || []).map(([k]) => k)
  }
  if (iconPool.length === 0) {
    iconPool = Object.keys(ICON_DATA)
  }

  const matchedTags = new Set<string>()
  if (fullText) {
    for (const item of STYLE_TAGS) {
      if (fullText.includes(item.word)) {
        matchedTags.add(item.tag)
      }
    }
  }

  let palettePool = PALETTES
  if (matchedTags.size > 0) {
    const filtered = PALETTES.filter(p => p.tags.some(tag => matchedTags.has(tag)))
    if (filtered.length > 0) {
      palettePool = filtered
    }
  }

  const plans: LogoPlan[] = []
  for (let i = 0; i < PLAN_COUNT; i++) {
    const template = TEMPLATES[(seed + i) % TEMPLATES.length].id
    const palette = palettePool[(seed + i) % palettePool.length].id
    const icon = iconPool[(seed + i) % iconPool.length]
    const font = FONTS[(seed + i) % FONTS.length].id
    plans.push({ template, palette, icon, font })
  }

  return plans
}

/**
 * 综合生成方案：结合大模型调用与关键词规则兜底
 *
 * @param req 方案生成请求参数
 * @param run 调模型的异步执行函数
 * @returns 最终生成的方案集合及执行状态
 * @example
 * ```ts
 * const res = await generatePlans({ name: '星空咖啡', slogan: '', desc: '' }, runPrompt)
 * ```
 */
export async function generatePlans(
  req: PlanRequest,
  run: RunPrompt
): Promise<GeneratePlansResult> {
  let lastIssue: string | undefined

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const prompt = buildPlanPrompt(req, lastIssue)
    const raw = await run(prompt, attempt)
    const parsed = parsePlansJson(raw)
    if (!parsed) {
      lastIssue = MSG_UNABLE_PARSE_JSON
      continue
    }

    const validated = validatePlans(parsed)
    if ('issue' in validated) {
      lastIssue = validated.issue
      continue
    }

    const validPlans = [...validated.plans]
    if (validPlans.length < PLAN_COUNT) {
      const fallback = planByKeywords(req)
      const existingKeys = new Set(
        validPlans.map(p => `${p.template}${SEPARATOR}${p.palette}${SEPARATOR}${p.icon}`)
      )
      for (const item of fallback) {
        const key = `${item.template}${SEPARATOR}${item.palette}${SEPARATOR}${item.icon}`
        if (!existingKeys.has(key)) {
          existingKeys.add(key)
          validPlans.push(item)
          if (validPlans.length >= PLAN_COUNT) break
        }
      }
    }

    return {
      plans: validPlans,
      source: SOURCE_AI,
      attempts: attempt,
    }
  }

  return {
    plans: planByKeywords(req),
    source: SOURCE_RULES,
    attempts: MAX_ATTEMPTS,
    note: lastIssue ?? MSG_DEFAULT_FALLBACK,
  }
}
