// 文字处理的纯逻辑：正则提取、查找替换、行处理、大小写、全半角、统计

/** 只读打开的最大字符数（约 2MB） */
export const MAX_OPEN_CHARS = 2 * 1024 * 1024
/** 全角空格 */
const FULL_SPACE = '　'
/** 全角字符与半角字符的码点差 */
const FULL_OFFSET = 0xfee0
/** 半角可见字符起点（!） */
const HALF_START = 0x21
/** 半角可见字符终点（~） */
const HALF_END = 0x7e

/** 正则提取选项 */
export interface ExtractOptions {
  /** 是否区分大小写 */
  caseSensitive?: boolean
  /** 是否去重 */
  unique?: boolean
}

/**
 * 构造全局正则，非法表达式抛 SyntaxError。
 *
 * @param pattern 正则源码
 * @param caseSensitive 是否区分大小写
 * @returns 带 g 标志的正则
 * @throws SyntaxError 表达式非法
 */
function buildRegex(pattern: string, caseSensitive: boolean): RegExp {
  return new RegExp(pattern, caseSensitive ? 'g' : 'gi')
}

/**
 * 用正则提取所有匹配。
 *
 * @param text 原文
 * @param pattern 正则源码，为空时返回空数组
 * @param opts 选项
 * @returns 匹配结果列表（取整体匹配）
 * @throws SyntaxError 正则非法
 * @example
 * regexExtract('a1b22', '\\d+') // ['1', '22']
 */
export function regexExtract(text: string, pattern: string, opts: ExtractOptions = {}): string[] {
  if (!pattern) return []
  const re = buildRegex(pattern, !!opts.caseSensitive)
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    // 空匹配要手动推进，避免死循环
    if (m[0] === '') {
      re.lastIndex++
      continue
    }
    out.push(m[0])
  }
  return opts.unique ? Array.from(new Set(out)) : out
}

/** 查找替换选项 */
export interface ReplaceOptions {
  /** 是否按正则处理 */
  regex?: boolean
  /** 是否区分大小写 */
  caseSensitive?: boolean
}

/** 查找替换结果 */
export interface ReplaceResult {
  /** 替换后的文本 */
  text: string
  /** 替换了几处 */
  count: number
}

/**
 * 展开替换模板里的 $$、$& 与 $n。
 *
 * @param tpl 模板
 * @param match 整体匹配
 * @param groups 捕获组列表
 * @returns 展开后的字符串
 */
function expandTemplate(tpl: string, match: string, groups: Array<string | undefined>): string {
  return tpl.replace(/\$(\$|&|\d{1,2})/g, (_s, k: string) => {
    if (k === '$') return '$'
    if (k === '&') return match
    const g = groups[Number(k) - 1]
    return g === undefined ? '' : g
  })
}

/**
 * 查找并全部替换。
 *
 * @param text 原文
 * @param find 查找内容，为空则原样返回
 * @param to 替换为（正则模式下支持 $1、$& 等）
 * @param opts 选项
 * @returns 新文本与替换处数
 * @throws SyntaxError 正则模式下表达式非法
 * @example
 * findReplace('a.b.c', '.', '-') // { text: 'a-b-c', count: 2 }
 */
export function findReplace(text: string, find: string, to: string, opts: ReplaceOptions = {}): ReplaceResult {
  if (!find) return { text, count: 0 }
  const source = opts.regex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = buildRegex(source, !!opts.caseSensitive)
  let count = 0
  const result = text.replace(re, (...args: unknown[]) => {
    count++
    if (!opts.regex) return to
    // 回调参数：匹配、捕获组…、位置、原串（有命名组时末尾多一个对象）
    const groups = args.slice(1).filter((a) => typeof a === 'string' || a === undefined)
    // 末尾的原串也是 string，要剔除
    groups.pop()
    return expandTemplate(to, String(args[0]), groups as Array<string | undefined>)
  })
  return { text: result, count }
}

/**
 * 按行去重，保留首次出现的顺序。
 *
 * @param text 原文
 * @returns 去重后的文本
 * @example
 * dedupeLines('a\nb\na') // 'a\nb'
 */
export function dedupeLines(text: string): string {
  return Array.from(new Set(text.split('\n'))).join('\n')
}

/**
 * 按行排序（中文按 localeCompare）。
 *
 * @param text 原文
 * @param desc 是否倒序
 * @returns 排序后的文本
 * @example
 * sortLines('b\na') // 'a\nb'
 */
export function sortLines(text: string, desc = false): string {
  const lines = text.split('\n').sort((a, b) => a.localeCompare(b, 'zh'))
  if (desc) lines.reverse()
  return lines.join('\n')
}

/**
 * 去掉空行（仅含空白的行也算空行）。
 *
 * @param text 原文
 * @returns 处理后的文本
 * @example
 * removeEmptyLines('a\n\n \nb') // 'a\nb'
 */
export function removeEmptyLines(text: string): string {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .join('\n')
}

/**
 * 去掉每行首尾空白（含全角空格）。
 *
 * @param text 原文
 * @returns 处理后的文本
 * @example
 * trimLines('  a \n b') // 'a\nb'
 */
export function trimLines(text: string): string {
  return text
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
}

/** 大小写模式 */
export type CaseMode = 'upper' | 'lower' | 'title'

/**
 * 转换大小写。
 *
 * @param text 原文
 * @param mode upper 全大写 / lower 全小写 / title 每个英文单词首字母大写
 * @returns 转换后的文本
 * @example
 * changeCase('hello world', 'title') // 'Hello World'
 */
export function changeCase(text: string, mode: CaseMode): string {
  if (mode === 'upper') return text.toUpperCase()
  if (mode === 'lower') return text.toLowerCase()
  return text.toLowerCase().replace(/[a-z]+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1))
}

/**
 * 全角转半角（含全角空格）。
 *
 * @param text 原文
 * @returns 半角文本
 * @example
 * toHalfWidth('ＡＢＣ１２３') // 'ABC123'
 */
export function toHalfWidth(text: string): string {
  let out = ''
  for (const ch of text) {
    const c = ch.codePointAt(0) as number
    if (ch === FULL_SPACE) out += ' '
    else if (c >= HALF_START + FULL_OFFSET && c <= HALF_END + FULL_OFFSET) out += String.fromCharCode(c - FULL_OFFSET)
    else out += ch
  }
  return out
}

/**
 * 半角转全角（含空格）。
 *
 * @param text 原文
 * @returns 全角文本
 * @example
 * toFullWidth('ABC 1') // 'ＡＢＣ　１'
 */
export function toFullWidth(text: string): string {
  let out = ''
  for (const ch of text) {
    const c = ch.codePointAt(0) as number
    if (ch === ' ') out += FULL_SPACE
    else if (c >= HALF_START && c <= HALF_END) out += String.fromCharCode(c + FULL_OFFSET)
    else out += ch
  }
  return out
}

/** 文本统计结果 */
export interface TextStats {
  /** 字符数（按码点，含空白） */
  chars: number
  /** 不含空白的字符数 */
  charsNoSpace: number
  /** 行数（空文本为 0） */
  lines: number
  /** UTF-8 字节数 */
  bytes: number
}

/**
 * 计算 UTF-8 字节数（不依赖 TextEncoder）。
 *
 * @param text 文本
 * @returns 字节数
 * @example
 * utf8Length('你') // 3
 */
export function utf8Length(text: string): number {
  let n = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) as number
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4
  }
  return n
}

/**
 * 统计字数、行数、字节数。
 *
 * @param text 原文
 * @returns 统计结果
 * @example
 * textStats('你好\nab') // { chars: 5, charsNoSpace: 4, lines: 2, bytes: 9 }
 */
export function textStats(text: string): TextStats {
  if (text === '') return { chars: 0, charsNoSpace: 0, lines: 0, bytes: 0 }
  const chars = Array.from(text).length
  const charsNoSpace = Array.from(text.replace(/\s/g, '')).length
  return { chars, charsNoSpace, lines: text.split('\n').length, bytes: utf8Length(text) }
}

/** 截断结果 */
export interface Truncated {
  /** 截断后的文本 */
  text: string
  /** 是否被截断 */
  truncated: boolean
}

/**
 * 超长文本只保留前 max 个字符（UTF-16 单元）。
 *
 * @param text 原文
 * @param max 最大字符数，默认 2MB
 * @returns 截断结果
 * @example
 * truncateText('abcdef', 3) // { text: 'abc', truncated: true }
 */
export function truncateText(text: string, max = MAX_OPEN_CHARS): Truncated {
  if (text.length <= max) return { text, truncated: false }
  let cut = max
  // 避免把代理对从中间截断
  const code = text.charCodeAt(cut - 1)
  if (code >= 0xd800 && code <= 0xdbff) cut--
  return { text: text.slice(0, cut), truncated: true }
}

/** 分享用文件名的默认值 */
export const SHARE_DEFAULT_NAME = 'text.txt'
/** 文件名里不允许出现的字符 */
const ILLEGAL_NAME_CHARS = /[\/:*?"<>|\u0000-\u001f]/g

/**
 * 整理分享用的文件名：去掉非法字符、去首尾空白，空了用默认名，没扩展名补 `.txt`。
 *
 * @param name 原文件名（可为空）
 * @returns 可安全写进缓存的文件名
 * @example
 * shareFileName('a/b:c') // 'a_b_c.txt'
 * shareFileName('') // 'text.txt'
 */
export function shareFileName(name: string): string {
  const clean = name.replace(ILLEGAL_NAME_CHARS, '_').trim()
  if (!clean || /^\.+$/.test(clean)) return SHARE_DEFAULT_NAME
  return /\.[^.]+$/.test(clean) ? clean : `${clean}.txt`
}
