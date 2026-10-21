// logo 符号概念映射：品牌描述 → 4 个可剪影的英文物体词（内置词表为主，本地 Qwen 备用，最后通用词兜底）。纯函数，便于单测。

import type { IconGroup } from './assets/iconData'
import { matchIndustryGroups } from './plan'

/** 空串 */
const EMPTY = ''
/** 单空格 */
const SPACE = ' '
/** 每组概念的个数 */
export const CONCEPT_COUNT = 4
/** Qwen 最多尝试次数（首次 + 重试一次） */
const MAX_QWEN_ATTEMPTS = 2
/** 一个物体词去掉冠词后最多几个单词 */
const OBJECT_WORDS_MAX = 3
/** JSON 里的数组字段名 */
const FIELD_OBJECTS = 'objects'
/** 反斜杠（JSON 字符串转义符） */
const BACKSLASH = String.fromCharCode(92)
/** 可忽略的冠词 */
const ARTICLES = ['a', 'an', 'the']
/** 连续空白 */
const RE_SPACES = /\s+/g
/** 首尾的非字母 */
const RE_EDGE_NON_LETTER = /^[^a-z]+|[^a-z]+$/g
/** 合法单词：小写字母，可用连字符连接 */
const RE_WORD = /^[a-z]+(-[a-z]+)*$/
/** 纯 ASCII 关键词（按单词边界匹配） */
const RE_ASCII_KEYWORD = /^[a-z0-9_-]+$/
/** 正则特殊字符 */
const RE_REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g
/** 提示词模板前缀（spike 第三轮最佳 P7） */
const PROMPT_PREFIX = 'flat pictogram glyph of '
/** 提示词模板后缀 */
const PROMPT_SUFFIX = ', solid black emoji silhouette, bold simple shape, minimalist icon, white background'
/** 元音字母，决定补 a 还是 an */
const VOWELS = 'aeiou'

/** 一个行业：中文关键词 + 4 个可剪影物体 */
export interface Industry {
  /** 行业 id */
  id: string
  /** 中文名 */
  name: string
  /** 关键词（中文为主；英文只收长度 >= 4 的词，按单词边界匹配） */
  keywords: string[]
  /** 对应的图标分组，仅用于“关键词没中、行业词表命中分组”时的兜底 */
  group?: IconGroup
  /** 4 个英文物体词 */
  objects: [string, string, string, string]
}

/** 概念来源：关键词 / 行业分组兜底 / 本地 Qwen / 通用词 */
export type ConceptSource = 'keyword' | 'group' | 'qwen' | 'generic'

/** 一次概念解析的结果 */
export interface ConceptResult {
  /** 恰好 4 个英文物体词 */
  objects: string[]
  /** 来源 */
  source: ConceptSource
  /** 命中的行业 id（关键词或分组命中时有值） */
  industry?: string
}

/** 调 Qwen 的函数：参数为提示词与第几次尝试，返回原文 */
export type RunConceptPrompt = (prompt: string, attempt: number) => Promise<string>

/** 通用兜底 4 个词：单一、具体、可剪影，且不与行业词重复 */
export const GENERIC_OBJECTS: readonly [string, string, string, string] = ['a feather', 'a lantern', 'a crown', 'a telescope']

/** 内置行业词表（前 30 个沿用桌面 spike v3 调过的词，其余同原则补充） */
export const INDUSTRIES: readonly Industry[] = [
  { id: 'coffee', name: '咖啡', group: 'food', keywords: ['咖啡', '拿铁', '手冲', 'coffee', 'cafe', 'espresso'], objects: ['a coffee cup with steam', 'a coffee bean', 'a coffee pot', 'a takeaway coffee cup'] },
  { id: 'bakery', name: '烘焙面包', group: 'food', keywords: ['烘焙', '面包', '吐司', '法棍', '可颂', 'bakery', 'bread'], objects: ['a croissant', 'a wheat ear', 'a loaf of bread', 'a baguette'] },
  { id: 'petclinic', name: '宠物医院', group: 'pet', keywords: ['宠物医院', '动物医院', '宠物诊所', '兽医', 'veterinary'], objects: ['a paw print', 'a cat head', 'a dog head', 'a bone'] },
  { id: 'gym', name: '健身', group: 'sport', keywords: ['健身', '力量训练', '撸铁', '私教', '器械', 'fitness', 'workout', 'crossfit'], objects: ['a dumbbell', 'a kettlebell', 'a flexed arm', 'a barbell'] },
  { id: 'bookstore', name: '书店', group: 'edu', keywords: ['书店', '书屋', '书局', '图书', '阅读', 'bookstore', 'library'], objects: ['an open book', 'a stack of books', 'a bookshelf', 'a closed book'] },
  { id: 'ai', name: '人工智能', group: 'tech', keywords: ['人工智能', '机器学习', '深度学习', '大模型', '机器人', 'robot', 'artificial'], objects: ['a robot head', 'a microchip', 'a brain', 'a light bulb'] },
  { id: 'logistics', name: '物流快递', group: 'auto', keywords: ['物流', '快递', '货运', '配送', '仓储', 'logistics', 'courier', 'delivery'], objects: ['a delivery truck', 'a parcel box with an arrow', 'a cargo plane', 'a location pin'] },
  { id: 'newenergy', name: '新能源', group: 'tech', keywords: ['新能源', '光伏', '风电', '充电桩', '储能', '电池', 'solar'], objects: ['a lightning bolt', 'a wind turbine', 'a solar panel', 'an electric plug'] },
  { id: 'barber', name: '理发美发', group: 'beauty', keywords: ['理发', '美发', '发廊', '造型工作室', '剪发', 'barber', 'salon'], objects: ['a pair of scissors', 'a comb', 'a barber pole', 'a razor'] },
  { id: 'game', name: '游戏', group: 'tech', keywords: ['游戏', '电竞', '桌游', 'esports', 'gaming'], objects: ['a game controller', 'a joystick', 'a pixel space invader', 'a dice'] },
  { id: 'eco', name: '环保', group: 'nature', keywords: ['环保', '环境保护', '低碳', '回收', '节能', '绿色生活', 'recycle', 'ecology'], objects: ['recycling arrows', 'a leaf', 'a tree', 'a globe'] },
  { id: 'bubbletea', name: '奶茶', group: 'food', keywords: ['奶茶', '果茶', '茶饮', '饮品', '珍珠', 'boba'], objects: ['a bubble tea cup with a straw', 'a drink cup with a lid', 'a tapioca pearl drink cup', 'a milk tea cup'] },
  { id: 'kids_edu', name: '少儿教育', group: 'edu', keywords: ['少儿', '幼儿', '早教', '启蒙', '托管', '儿童教育', 'preschool', 'kindergarten'], objects: ['a sprout growing from an open book', 'a pencil', 'a graduation cap', 'a school bag'] },
  { id: 'coding', name: '编程培训', group: 'tech', keywords: ['编程', '代码', '程序员', '软件开发', 'coding', 'programming', 'developer'], objects: ['angle brackets code symbol', 'a laptop with code brackets', 'a terminal prompt', 'a computer mouse'] },
  { id: 'yoga', name: '瑜伽', group: 'sport', keywords: ['瑜伽', '普拉提', '冥想', 'yoga', 'pilates'], objects: ['a lotus flower', 'a meditating person in lotus pose', 'a person in tree pose', 'a yoga mat'] },
  { id: 'dental', name: '牙科', group: 'health', keywords: ['牙科', '口腔', '牙齿', '齿科', '正畸', 'dental', 'dentist'], objects: ['a tooth', 'a tooth with a sparkle', 'a toothbrush', 'a dental mirror'] },
  { id: 'florist', name: '花店', group: 'nature', keywords: ['花店', '花艺', '鲜花', '花坊', '插花', 'florist', 'flower'], objects: ['a single flower with petals', 'a tulip', 'a rose', 'a bouquet of flowers'] },
  { id: 'photo', name: '摄影', group: 'art', keywords: ['摄影', '照相', '写真', '影楼', 'photo', 'camera'], objects: ['a camera', 'a camera lens', 'a polaroid camera', 'a tripod'] },
  { id: 'travel', name: '旅行', group: 'travel', keywords: ['旅行', '旅游', '旅拍', '航空', '机票', 'travel', 'tourism'], objects: ['a paper plane', 'an airplane', 'a suitcase', 'a hot air balloon'] },
  { id: 'homestay', name: '民宿', group: 'home', keywords: ['民宿', '客栈', '短租', '青旅', 'homestay', 'hostel'], objects: ['a house with a heart', 'a cozy house', 'a bed', 'a door key'] },
  { id: 'law', name: '律所', group: 'general', keywords: ['律所', '律师', '法律', '法务', '诉讼', 'lawyer', 'attorney'], objects: ['balance scales', 'a gavel', 'a column pillar', 'a scroll'] },
  { id: 'accounting', name: '财税会计', group: 'finance', keywords: ['会计', '财税', '记账', '审计', '税务', 'accounting', 'audit'], objects: ['a bar chart with an upward arrow', 'a calculator', 'a coin stack', 'a ledger book'] },
  { id: 'startup', name: '创业', group: 'tech', keywords: ['创业', '孵化', '初创', '众创', 'startup', 'incubator'], objects: ['a rocket', 'a light bulb', 'a rising arrow', 'a flag'] },
  { id: 'ecommerce', name: '电商', group: 'retail', keywords: ['电商', '网店', '淘宝', '直播带货', '跨境', 'ecommerce', 'webshop'], objects: ['a shopping bag', 'a shopping cart', 'a price tag', 'a parcel box'] },
  { id: 'autorepair', name: '汽修', group: 'auto', keywords: ['汽修', '汽车维修', '汽车保养', '钣金', '洗车', '轮胎', 'garage', 'mechanic'], objects: ['a wrench and a gear', 'a car', 'a spanner', 'a car tire'] },
  { id: 'farm', name: '农场农业', group: 'nature', keywords: ['农场', '农业', '农庄', '种植', '农产品', '有机', 'farm', 'organic'], objects: ['a carrot', 'an ear of corn', 'a tomato', 'a barn'] },
  { id: 'tea', name: '茶馆茶叶', group: 'food', keywords: ['茶馆', '茶叶', '茶庄', '茶艺', '茶道', '茶楼', '茶社', 'teahouse'], objects: ['a tea leaf', 'a teapot', 'a tea cup', 'a tea whisk'] },
  { id: 'hotpot', name: '火锅', group: 'food', keywords: ['火锅', '涮肉', '串串', '麻辣烫', 'hotpot'], objects: ['a pot with steam', 'a chili pepper', 'a bowl with chopsticks', 'a hot pot ladle'] },
  { id: 'beauty', name: '美妆', group: 'beauty', keywords: ['美妆', '护肤', '美容', '彩妆', '香水', '化妆', 'cosmetic', 'beauty', 'makeup'], objects: ['a lipstick', 'a perfume bottle', 'a hand mirror', 'a makeup brush'] },
  { id: 'music', name: '音乐', group: 'art', keywords: ['音乐', '乐队', '琴行', '乐器', '录音', '吉他', 'music', 'guitar'], objects: ['headphones', 'a musical note', 'a guitar', 'a piano'] },
  { id: 'restaurant', name: '餐厅', group: 'food', keywords: ['餐厅', '餐馆', '饭店', '私房菜', '料理', '小馆', '美食', '餐饮', 'restaurant', 'bistro', 'kitchen'], objects: ['a chef hat', 'a cloche food cover', 'a fork and spoon', 'a dinner plate'] },
  { id: 'fastfood', name: '快餐汉堡', group: 'food', keywords: ['快餐', '汉堡', '炸鸡', '薯条', '披萨', 'burger', 'pizza'], objects: ['a hamburger', 'a box of french fries', 'a hot dog', 'a pizza slice'] },
  { id: 'bar', name: '酒吧', group: 'food', keywords: ['酒吧', '精酿', '小酒馆', '居酒屋', '鸡尾酒', '威士忌', 'cocktail', 'brewery', 'whisky'], objects: ['a cocktail glass', 'a beer mug with foam', 'a wine bottle', 'a cocktail shaker'] },
  { id: 'dessert', name: '甜品冰淇淋', group: 'food', keywords: ['甜品', '甜点', '冰淇淋', '雪糕', '蛋糕', '马卡龙', 'dessert', 'icecream'], objects: ['an ice cream cone', 'a cupcake', 'a donut', 'a slice of cake'] },
  { id: 'fruit', name: '水果生鲜', group: 'food', keywords: ['水果', '生鲜', '果业', '果蔬', '鲜果', 'fruit'], objects: ['an apple', 'a banana', 'a strawberry', 'a pineapple'] },
  { id: 'clothing', name: '服装', group: 'retail', keywords: ['服装', '女装', '男装', '童装', '成衣', '裁缝', '定制西服', 'clothing', 'apparel', 'fashion'], objects: ['a clothes hanger', 'a t-shirt', 'a dress', 'a sewing machine'] },
  { id: 'jewelry', name: '珠宝', group: 'retail', keywords: ['珠宝', '首饰', '钻石', '翡翠', '黄金', '玉器', 'jewelry', 'jewellery', 'diamond'], objects: ['a diamond ring', 'a necklace', 'a gemstone', 'a pearl'] },
  { id: 'hospital', name: '医院医疗', group: 'health', keywords: ['医院', '诊所', '医疗', '门诊', '医生', '体检', 'hospital', 'clinic', 'medical'], objects: ['a stethoscope', 'a medical syringe', 'a medical cross', 'a heart'] },
  { id: 'pharmacy', name: '药店', group: 'health', keywords: ['药店', '药房', '药业', '医药', '药品', 'pharmacy', 'drugstore'], objects: ['a medicine bottle', 'a capsule pill', 'a mortar and pestle', 'a first aid kit'] },
  { id: 'school', name: '学校教育', group: 'edu', keywords: ['学校', '学院', '培训', '教育', '补习', '辅导', '课程', 'school', 'academy'], objects: ['a graduation cap', 'a blackboard', 'a desk and chair', 'a school bell'] },
  { id: 'realestate', name: '房产', group: 'home', keywords: ['房产', '地产', '中介', '置业', '物业', '租房', 'realty', 'realtor'], objects: ['a house with a chimney', 'an apartment building', 'a for sale sign', 'a front door'] },
  { id: 'furniture', name: '家具家居', group: 'home', keywords: ['家具', '家居', '软装', '装修', '装饰', '木艺', 'furniture'], objects: ['an armchair', 'a table lamp', 'a sofa', 'a wardrobe'] },
  { id: 'cleaning', name: '家政清洁', group: 'home', keywords: ['家政', '保洁', '清洁', '月嫂', '钟点工', 'cleaning', 'maid'], objects: ['a broom and dustpan', 'a spray bottle', 'a vacuum cleaner', 'a bucket'] },
  { id: 'wedding', name: '婚庆', group: 'art', keywords: ['婚庆', '婚礼', '婚纱', '婚宴', '新娘', 'wedding', 'bridal'], objects: ['a wedding arch', 'a champagne flute', 'a wedding veil', 'a wedding cake'] },
  { id: 'baby', name: '母婴', group: 'retail', keywords: ['母婴', '婴儿', '宝宝', '孕妇', '月子', '育儿', 'maternity'], objects: ['a baby stroller', 'a baby bottle', 'a pacifier', 'a rattle'] },
  { id: 'petshop', name: '宠物店', group: 'pet', keywords: ['宠物', '猫舍', '狗舍', '猫咖', '水族', 'petshop'], objects: ['a dog head', 'a cat head', 'a fish', 'a bird cage'] },
  { id: 'cycling', name: '骑行', group: 'sport', keywords: ['骑行', '自行车', '单车', '山地车', 'cycling', 'bicycle'], objects: ['a bicycle', 'a bicycle helmet', 'a bicycle wheel', 'a water bottle'] },
  { id: 'camping', name: '露营', group: 'travel', keywords: ['露营', '野营', '帐篷', '徒步', '登山', '户外', 'camping', 'hiking'], objects: ['a camping tent', 'a campfire', 'a compass', 'a sleeping bag'] },
  { id: 'finance', name: '金融投资', group: 'finance', keywords: ['金融', '投资', '理财', '基金', '证券', '银行', '保险', '资管', 'finance', 'invest', 'capital'], objects: ['a bank building', 'a piggy bank', 'a gold coin', 'a safe'] },
  { id: 'security', name: '安防', group: 'tech', keywords: ['安防', '安保', '监控', '门锁', '保安', 'security', 'alarm'], objects: ['a shield', 'a padlock', 'a key', 'a surveillance camera'] },
  { id: 'design', name: '设计广告', group: 'art', keywords: ['设计', '广告', '创意', '品牌策划', '印刷', '文创', 'design'], objects: ['a paint brush', 'a pencil', 'a ruler', 'a color palette'] },
  { id: 'video', name: '影视', group: 'art', keywords: ['影视', '电影', '视频', '短视频', '传媒', '影业', 'film', 'video', 'movie'], objects: ['a clapperboard', 'a video camera', 'a film reel', 'a play button'] },
  { id: 'art', name: '艺术画廊', group: 'art', keywords: ['画廊', '美术', '艺术', '书法', '陶艺', '手作', '绘画', 'gallery', 'pottery'], objects: ['a paint palette', 'a paint brush', 'a vase', 'a picture frame'] },
  { id: 'tech', name: '科技软件', group: 'tech', keywords: ['科技', '软件', '互联网', '数据', '云计算', '信息技术', '网络', 'tech', 'software', 'cloud'], objects: ['a laptop', 'a smartphone', 'a cloud', 'a gear'] },
  { id: 'hotel', name: '酒店', group: 'travel', keywords: ['酒店', '宾馆', '旅馆', '度假村', 'hotel', 'resort'], objects: ['a reception bell', 'a luxury bed', 'a door key', 'a luggage cart'] },
  { id: 'seafood', name: '海鲜', group: 'food', keywords: ['海鲜', '渔港', '水产', '烧烤', '捕捞', 'seafood', 'fishery'], objects: ['a fish', 'a crab', 'a shrimp', 'an anchor'] },
  { id: 'candle', name: '香氛', group: 'home', keywords: ['香氛', '蜡烛', '香薰', '精油', '香道', 'candle', 'aroma'], objects: ['a candle', 'a perfume bottle', 'a flower', 'a leaf'] },
  { id: 'toy', name: '玩具', group: 'retail', keywords: ['玩具', '积木', '潮玩', '手办', '模型', 'toys'], objects: ['a teddy bear', 'a toy car', 'a building block', 'a balloon'] },
  { id: 'optical', name: '眼镜', group: 'health', keywords: ['眼镜', '视光', '眼科', '验光', 'optical', 'glasses'], objects: ['a pair of glasses', 'an eye', 'sunglasses', 'a contact lens'] },
  { id: 'laundry', name: '洗衣', group: 'home', keywords: ['洗衣', '干洗', '洗涤', '熨烫', 'laundry'], objects: ['a washing machine', 'a t-shirt', 'a clothes hanger', 'an iron'] },
  { id: 'phonerepair', name: '手机维修', group: 'tech', keywords: ['手机维修', '手机', '数码', '电脑维修', '通讯', 'smartphone', 'mobile'], objects: ['a smartphone', 'a screwdriver', 'a battery', 'a headphone'] },
  { id: 'spa', name: '按摩养生', group: 'beauty', keywords: ['按摩', '养生', '推拿', '足疗', '艾灸', '理疗', 'massage', 'wellness'], objects: ['a stack of stones', 'a lotus flower', 'a leaf', 'a candle'] },
  { id: 'sports', name: '运动', group: 'sport', keywords: ['运动', '篮球', '足球', '羽毛球', '网球', '跑步', '游泳', 'sports', 'running', 'basketball', 'football'], objects: ['a basketball', 'a soccer ball', 'a running shoe', 'a trophy'] },
]

/** 压缩空白并去首尾空格 */
function squash(s: string): string {
  return s.trim().replace(RE_SPACES, SPACE)
}

/** 关键词是否命中文本：纯 ASCII 关键词按单词边界，其余用包含 */
function hit(textLower: string, keyword: string): boolean {
  const kw = keyword.trim().toLowerCase()
  if (!kw) return false
  if (RE_ASCII_KEYWORD.test(kw)) return new RegExp(`\\b${kw.replace(RE_REGEX_SPECIAL, '\\$&')}\\b`).test(textLower)
  return textLower.includes(kw)
}

/**
 * 按关键词匹配行业：最长命中词优先，同长按词表顺序。
 *
 * @param text 品牌名 + 标语 + 描述拼起来的文本
 * @returns 命中的行业；没命中为 null
 * @example matchIndustry('奶茶店')?.id // 'bubbletea'
 */
export function matchIndustry(text: string): Industry | null {
  const t = (text ?? EMPTY).toLowerCase()
  if (!t) return null
  let best: Industry | null = null
  let bestLen = 0
  for (const ind of INDUSTRIES) {
    for (const kw of ind.keywords) {
      if (kw.length > bestLen && hit(t, kw)) {
        best = ind
        bestLen = kw.length
      }
    }
  }
  return best
}

/**
 * 不调模型的概念解析：先关键词，再退到 plan.ts 行业词表命中的图标分组（取该分组的第一个行业）。
 *
 * @param text 品牌名 + 标语 + 描述
 * @returns 解析结果；都没命中为 null
 * @example conceptsFromText('山屿咖啡')?.source // 'keyword'
 */
export function conceptsFromText(text: string): ConceptResult | null {
  const ind = matchIndustry(text)
  if (ind) return { objects: [...ind.objects], source: 'keyword', industry: ind.id }
  const group = matchIndustryGroups(text)[0]
  const byGroup = group ? INDUSTRIES.find((i) => i.group === group) : undefined
  return byGroup ? { objects: [...byGroup.objects], source: 'group', industry: byGroup.id } : null
}

/**
 * 构造让 Qwen 只输出 4 个英文物体名词的提示词。
 *
 * @param text 品牌描述
 * @param lastIssue 上一次输出的问题（重试时带上）
 * @returns 提示词
 * @example buildConceptPrompt('星空咖啡')
 */
export function buildConceptPrompt(text: string, lastIssue?: string): string {
  const fix = lastIssue ? `\n上一次的问题：${lastIssue}。请修正。` : EMPTY
  return `根据品牌信息，列出 4 个能代表它的英文实物名词，用来画单色剪影图标。
品牌信息：${text}
规则：每个都是看得见摸得着的单一物体（如 a coffee cup、a dumbbell、a tent），不要抽象词（如 space、journey、whimsy），不要品牌名，每个 1 到 3 个英文单词，4 个互不相同。
只输出一行 JSON，以 { 开头，不要代码块和解释。格式示例：
品牌信息：星火烧烤 -> {"objects":["a grill","a meat skewer","a flame","a beer mug"]}
品牌信息：云朵少儿编程 -> {"objects":["a robot","a laptop","a cloud","a pencil"]}${fix}`
}

/**
 * 规范化一个英文物体词：小写、去标点、去冠词后须为 1~3 个字母词，再补 a/an。
 *
 * @param raw 原始值
 * @returns 规范化结果；不合格为 null
 * @example normalizeObject('Coffee cup!') // 'a coffee cup'
 */
export function normalizeObject(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = squash(raw.toLowerCase()).replace(RE_EDGE_NON_LETTER, EMPTY)
  if (!s) return null
  const words = s.split(SPACE)
  if (!words.every((w) => RE_WORD.test(w))) return null
  if (ARTICLES.includes(words[0])) words.shift()
  if (words.length < 1 || words.length > OBJECT_WORDS_MAX) return null
  const core = words.join(SPACE)
  return `${VOWELS.includes(core[0]) ? 'an' : 'a'} ${core}`
}

/** 从文本里取第一个括号配平的 JSON 值子串（对象或数组，哪个先出现取哪个） */
function firstJsonValue(s: string): string | null {
  const start = s.search(/[{[]/)
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (esc) esc = false
    else if (c === BACKSLASH) esc = true
    else if (c === '"') inStr = !inStr
    else if (!inStr && (c === '{' || c === '[')) depth++
    else if (!inStr && (c === '}' || c === ']') && --depth === 0) return s.slice(start, i + 1)
  }
  return null
}

/** 一个元素转成待规范化的字符串：字符串原样，字符串数组用空格拼起来（小模型常把一个词拆成数组），其它为 null */
function itemToText(it: unknown): unknown {
  return Array.isArray(it) && it.every((x) => typeof x === 'string') ? it.join(SPACE) : it
}

/**
 * 解析并校验 Qwen 的输出：容忍代码围栏与前后废话；接受 `{"objects":[...]}` 或裸数组（0.8B 模型常省掉外层对象）；
 * 逐个规范化、去重，凑够 4 个才算成功。
 *
 * @param text 模型原文
 * @returns 成功给 4 个物体词，失败给中文原因
 * @example parseObjectsJson('{"objects":["a cup","a bean","a pot","a mug"]}') // { objects: [...] }
 */
export function parseObjectsJson(text: string): { objects: string[] } | { issue: string } {
  const json = firstJsonValue(text ?? EMPTY)
  if (!json) return { issue: '没有找到 JSON' }
  let val: unknown
  try {
    val = JSON.parse(json)
  } catch {
    return { issue: 'JSON 语法有误' }
  }
  const arr = Array.isArray(val) ? val : (val as Record<string, unknown> | null)?.[FIELD_OBJECTS]
  if (!Array.isArray(arr)) return { issue: '缺少 objects 数组' }
  const out: string[] = []
  for (const it of arr) {
    const n = normalizeObject(itemToText(it))
    if (n && !out.includes(n)) out.push(n)
  }
  if (out.length < CONCEPT_COUNT) return { issue: `只有 ${out.length} 个有效英文名词，需要 ${CONCEPT_COUNT} 个` }
  return { objects: out.slice(0, CONCEPT_COUNT) }
}

/**
 * 让 Qwen 给出 4 个物体词，最多调用 2 次（第 2 次带上次的问题）；run 抛错（取消、未就绪）直接透出。
 *
 * @param text 品牌描述
 * @param run 调模型的函数
 * @returns 结果；两次都不合格为 null
 * @example await conceptsFromQwen('星空咖啡', run)
 */
export async function conceptsFromQwen(text: string, run: RunConceptPrompt): Promise<ConceptResult | null> {
  let issue: string | undefined
  for (let attempt = 1; attempt <= MAX_QWEN_ATTEMPTS; attempt++) {
    const r = parseObjectsJson(await run(buildConceptPrompt(text, issue), attempt))
    if ('objects' in r) return { objects: r.objects, source: 'qwen' }
    issue = r.issue
  }
  return null
}

/**
 * 综合解析：词表（关键词、分组）→ Qwen（run 非空时）→ 通用词。
 *
 * @param text 品牌名 + 标语 + 描述
 * @param run 调 Qwen 的函数；Qwen 未就绪传 null
 * @returns 恰好 4 个物体词的结果
 * @example await resolveConcepts('山屿咖啡', null) // source 'keyword'
 */
export async function resolveConcepts(text: string, run: RunConceptPrompt | null): Promise<ConceptResult> {
  const local = conceptsFromText(text)
  if (local) return local
  const q = run ? await conceptsFromQwen(text, run) : null
  return q ?? { objects: [...GENERIC_OBJECTS], source: 'generic' }
}

/**
 * 概念词 → 文生图提示词（P7 模板）。
 *
 * @param concept 英文物体词
 * @returns 提示词
 * @example conceptPrompt('a dumbbell') // 'flat pictogram glyph of a dumbbell, solid black ...'
 */
export function conceptPrompt(concept: string): string {
  return `${PROMPT_PREFIX}${squash(concept ?? EMPTY)}${PROMPT_SUFFIX}`
}

/**
 * 概念来源的中文说明，给页面展示。
 *
 * @param r 解析结果
 * @returns 说明文字
 * @example describeConcepts({ objects: [], source: 'keyword', industry: 'gym' }) // '按行业词表推荐：健身'
 */
export function describeConcepts(r: Pick<ConceptResult, 'source' | 'industry'>): string {
  const name = INDUSTRIES.find((i) => i.id === r.industry)?.name ?? EMPTY
  if (r.source === 'keyword') return `按行业词表推荐：${name}`
  if (r.source === 'group') return `按行业大类推荐：${name}`
  if (r.source === 'qwen') return '本地模型按描述推荐'
  return '没认出行业，先用通用图形'
}
