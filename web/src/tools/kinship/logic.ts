// 亲戚关系计算器：关系链 -> 称呼。先用改写规则化简，再查称谓表。自写，不依赖第三方库

/** 关系步骤：f 爸爸 m 妈妈 h 丈夫 w 妻子 ob 哥哥 lb 弟弟 os 姐姐 ls 妹妹 s 儿子 d 女儿 */
export type Step = 'f' | 'm' | 'h' | 'w' | 'ob' | 'lb' | 'os' | 'ls' | 's' | 'd'
/** 性别：m 男 f 女 */
export type Gender = 'm' | 'f'

/** 关系链最大长度，防止输入过长 */
export const MAX_CHAIN = 8
/** 空关系链的称呼 */
const SELF = '自己'
/** 称谓表键的分隔符 */
const SEP = ','
/** 关系链连接词 */
const LINK = '的'

/** 每个步骤对应的口语文本，同时用作界面按钮文字 */
export const STEP_LABEL: Record<Step, string> = {
  f: '爸爸',
  m: '妈妈',
  h: '丈夫',
  w: '妻子',
  ob: '哥哥',
  lb: '弟弟',
  os: '姐姐',
  ls: '妹妹',
  s: '儿子',
  d: '女儿',
}

/** 界面按钮顺序 */
export const STEP_ORDER: Step[] = ['f', 'm', 'ob', 'lb', 'os', 'ls', 'h', 'w', 's', 'd']

/** 每个步骤所指人物的性别 */
const STEP_GENDER: Record<Step, Gender> = {
  f: 'm',
  m: 'f',
  h: 'm',
  w: 'f',
  ob: 'm',
  lb: 'm',
  os: 'f',
  ls: 'f',
  s: 'm',
  d: 'f',
}

/** 同胞步骤 */
const SIBLINGS: Step[] = ['ob', 'lb', 'os', 'ls']
/** 比自己大的同胞 */
const OLDER: Step[] = ['ob', 'os']
/** 比自己小的同胞 */
const YOUNGER: Step[] = ['lb', 'ls']
/** 配偶步骤 */
const SPOUSES: Step[] = ['h', 'w']
/** 父母步骤 */
const PARENTS: Step[] = ['f', 'm']
/** 子女步骤 */
const CHILDREN: Step[] = ['s', 'd']

/** 计算结果：成功带称呼列表，失败带提示 */
export type KinshipResult = { ok: true; titles: string[] } | { ok: false; error: string }

/**
 * 称谓表：键是化简后的关系链（逗号连接），值是候选称呼。
 * 年龄不明时列出多个（如堂哥/堂弟）。
 */
const TITLES: Record<string, string[]> = {
  '': [SELF],
  // 直系与同胞
  f: ['爸爸'],
  m: ['妈妈'],
  h: ['丈夫'],
  w: ['妻子'],
  ob: ['哥哥'],
  lb: ['弟弟'],
  os: ['姐姐'],
  ls: ['妹妹'],
  s: ['儿子'],
  d: ['女儿'],
  // 祖辈
  'f,f': ['爷爷'],
  'f,m': ['奶奶'],
  'm,f': ['外公'],
  'm,m': ['外婆'],
  'f,f,f': ['曾祖父'],
  'f,f,m': ['曾祖母'],
  'f,m,f': ['外曾祖父'],
  'f,m,m': ['外曾祖母'],
  'm,f,f': ['外曾祖父'],
  'm,f,m': ['外曾祖母'],
  'm,m,f': ['外曾祖父'],
  'm,m,m': ['外曾祖母'],
  'f,f,ob': ['伯祖父'],
  'f,f,lb': ['叔祖父'],
  'f,f,os': ['姑婆'],
  'f,f,ls': ['姑婆'],
  'f,m,ob': ['舅爷'],
  'f,m,lb': ['舅爷'],
  'f,m,os': ['姨奶'],
  'f,m,ls': ['姨奶'],
  'm,m,ob': ['舅姥爷'],
  'm,m,lb': ['舅姥爷'],
  'm,m,os': ['姨姥姥'],
  'm,m,ls': ['姨姥姥'],
  'm,f,os': ['姑姥姥'],
  'm,f,ls': ['姑姥姥'],
  // 父母的同胞及其配偶
  'f,ob': ['伯父'],
  'f,lb': ['叔叔'],
  'f,os': ['姑妈'],
  'f,ls': ['姑妈'],
  'f,ob,w': ['伯母'],
  'f,lb,w': ['婶婶'],
  'f,os,h': ['姑父'],
  'f,ls,h': ['姑父'],
  'm,ob': ['舅舅'],
  'm,lb': ['舅舅'],
  'm,os': ['姨妈', '大姨'],
  'm,ls': ['姨妈', '小姨'],
  'm,ob,w': ['舅妈'],
  'm,lb,w': ['舅妈'],
  'm,os,h': ['姨父'],
  'm,ls,h': ['姨父'],
  // 堂表亲（年龄不明时两个都列）
  'f,ob,s': ['堂哥', '堂弟'],
  'f,ob,d': ['堂姐', '堂妹'],
  'f,lb,s': ['堂哥', '堂弟'],
  'f,lb,d': ['堂姐', '堂妹'],
  'f,os,s': ['表哥', '表弟'],
  'f,os,d': ['表姐', '表妹'],
  'f,ls,s': ['表哥', '表弟'],
  'f,ls,d': ['表姐', '表妹'],
  'm,ob,s': ['表哥', '表弟'],
  'm,ob,d': ['表姐', '表妹'],
  'm,lb,s': ['表哥', '表弟'],
  'm,lb,d': ['表姐', '表妹'],
  'm,os,s': ['表哥', '表弟'],
  'm,os,d': ['表姐', '表妹'],
  'm,ls,s': ['表哥', '表弟'],
  'm,ls,d': ['表姐', '表妹'],
  // 同胞的配偶与子女
  'ob,w': ['嫂子'],
  'lb,w': ['弟媳'],
  'os,h': ['姐夫'],
  'ls,h': ['妹夫'],
  'ob,s': ['侄子'],
  'ob,d': ['侄女'],
  'lb,s': ['侄子'],
  'lb,d': ['侄女'],
  'os,s': ['外甥'],
  'os,d': ['外甥女'],
  'ls,s': ['外甥'],
  'ls,d': ['外甥女'],
  // 配偶方
  'w,f': ['岳父'],
  'w,m': ['岳母'],
  'h,f': ['公公'],
  'h,m': ['婆婆'],
  'w,ob': ['大舅子'],
  'w,lb': ['小舅子'],
  'w,os': ['大姨子'],
  'w,ls': ['小姨子'],
  'h,ob': ['大伯子'],
  'h,lb': ['小叔子'],
  'h,os': ['大姑子'],
  'h,ls': ['小姑子'],
  'h,ob,w': ['妯娌'],
  'h,lb,w': ['妯娌'],
  'w,os,h': ['连襟'],
  'w,ls,h': ['连襟'],
  // 晚辈
  's,w': ['儿媳'],
  'd,h': ['女婿'],
  's,s': ['孙子'],
  's,d': ['孙女'],
  'd,s': ['外孙'],
  'd,d': ['外孙女'],
  's,s,s': ['曾孙'],
  's,s,d': ['曾孙女'],
  's,s,w': ['孙媳妇'],
  's,w,f': ['亲家公'],
  's,w,m': ['亲家母'],
  'd,h,f': ['亲家公'],
  'd,h,m': ['亲家母'],
}

/**
 * 关系链转口语文本。
 *
 * @param chain 关系链
 * @returns 如「爸爸的哥哥的儿子」；空链返回「我」
 * @example chainToText(['f', 'ob']) // '爸爸的哥哥'
 */
export function chainToText(chain: Step[]): string {
  return chain.length ? chain.map((s) => STEP_LABEL[s]).join(LINK) : '我'
}

/**
 * 校验关系链里的性别是否自洽（如男性的「丈夫」不成立）。
 *
 * @param chain 关系链
 * @param me 我的性别
 * @returns 通过返回 null，否则返回中文提示
 */
function checkGender(chain: Step[], me: Gender): string | null {
  for (let i = 0; i < chain.length; i++) {
    const holder = i === 0 ? me : STEP_GENDER[chain[i - 1]]
    const who = i === 0 ? '我' : STEP_LABEL[chain[i - 1]]
    if (chain[i] === 'w' && holder !== 'm') return `${who}是女性，不能有「妻子」`
    if (chain[i] === 'h' && holder !== 'f') return `${who}是男性，不能有「丈夫」`
  }
  return null
}

/**
 * 相邻两步的化简规则。
 *
 * @param a 前一步
 * @param b 后一步
 * @param g 前一步所指人物（即持有者）的性别
 * @returns 替换方案列表（空数组项表示回到持有者自己）；无规则返回 null
 */
function pairRule(a: Step, b: Step, g: Gender): Step[][] | null {
  if (SPOUSES.includes(a) && SPOUSES.includes(b) && a !== b) return [[]] // 妻子的丈夫 = 自己
  if (a === 'f' && b === 'w') return [['m']]
  if (a === 'm' && b === 'h') return [['f']]
  if (PARENTS.includes(a) && b === 's') return [['ob'], ['lb'], ...(g === 'm' ? [[]] : [])]
  if (PARENTS.includes(a) && b === 'd') return [['os'], ['ls'], ...(g === 'f' ? [[]] : [])]
  if (SIBLINGS.includes(a) && b === 'f') return [['f']]
  if (SIBLINGS.includes(a) && b === 'm') return [['m']]
  if (CHILDREN.includes(a) && b === 'm') return g === 'm' ? [['w']] : [[]]
  if (CHILDREN.includes(a) && b === 'f') return g === 'm' ? [[]] : [['h']]
  if (SPOUSES.includes(a) && CHILDREN.includes(b)) return [[b]]
  if (OLDER.includes(a) && OLDER.includes(b)) return [[b]] // 哥哥的姐姐仍比我大
  if (YOUNGER.includes(a) && YOUNGER.includes(b)) return [[b]]
  return null
}

/**
 * 反复套用化简规则，得到所有可能的最简关系链。
 *
 * @param chain 原始关系链
 * @param me 我的性别
 * @returns 去重后的最简链列表
 */
function simplify(chain: Step[], me: Gender): Step[][] {
  for (let i = 0; i < chain.length - 1; i++) {
    const g = i === 0 ? me : STEP_GENDER[chain[i - 1]]
    const alts = pairRule(chain[i], chain[i + 1], g)
    if (alts) {
      const out = alts.flatMap((r) => simplify([...chain.slice(0, i), ...r, ...chain.slice(i + 2)], me))
      const seen = new Set<string>()
      return out.filter((c) => {
        const k = c.join(SEP)
        return seen.has(k) ? false : (seen.add(k), true)
      })
    }
  }
  return [chain]
}

/**
 * 根据关系链计算称呼。
 *
 * @param chain 从「我」出发的关系链，如 `['f','ob','s']`
 * @param me 我的性别
 * @returns 成功带候选称呼（年龄不明时有多个），失败带提示
 * @example
 * calcKinship(['f', 'ob'], 'm') // { ok: true, titles: ['伯父'] }
 * calcKinship(['f', 'ob', 's'], 'm') // { ok: true, titles: ['堂哥', '堂弟'] }
 */
export function calcKinship(chain: Step[], me: Gender): KinshipResult {
  if (chain.length > MAX_CHAIN) return { ok: false, error: `关系链太长了，最多 ${MAX_CHAIN} 步` }
  const bad = checkGender(chain, me)
  if (bad) return { ok: false, error: bad }
  const titles: string[] = []
  for (const c of simplify(chain, me)) {
    for (const t of TITLES[c.join(SEP)] ?? []) if (!titles.includes(t)) titles.push(t)
  }
  if (!titles.length) return { ok: false, error: '这个关系暂时算不出称呼，试试拆短一点' }
  return { ok: true, titles }
}
