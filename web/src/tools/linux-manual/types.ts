// Linux 手册：类型与分类常量

/** 分类名：文件与目录 */
export const CAT_FILE = '文件与目录'
/** 分类名：文本处理 */
export const CAT_TEXT = '文本处理'
/** 分类名：查找与过滤 */
export const CAT_FIND = '查找与过滤'
/** 分类名：权限与用户 */
export const CAT_PERM = '权限与用户'
/** 分类名：进程与系统 */
export const CAT_PROC = '进程与系统'
/** 分类名：网络 */
export const CAT_NET = '网络'
/** 分类名：压缩与归档 */
export const CAT_ARCH = '压缩与归档'
/** 分类名：磁盘 */
export const CAT_DISK = '磁盘'
/** 分类名：包管理 */
export const CAT_PKG = '包管理'
/** 分类名：Shell 与其他 */
export const CAT_SHELL = 'Shell 与其他'

/** 全部分类，按展示顺序 */
export const CATEGORIES = [CAT_FILE, CAT_TEXT, CAT_FIND, CAT_PERM, CAT_PROC, CAT_NET, CAT_ARCH, CAT_DISK, CAT_PKG, CAT_SHELL] as const

/** 分类类型 */
export type Category = (typeof CATEGORIES)[number]

/** 一条命令的速查 */
export interface LinuxCmd {
  /** 命令名，全表唯一 */
  name: string
  /** 别名或相关写法，供搜索 */
  aliases: string[]
  /** 所属分类 */
  cat: Category
  /** 一句话作用 */
  brief: string
  /** 语法 */
  syntax: string
  /** 常用选项：[选项, 说明] */
  options: [string, string][]
  /** 示例：[命令, 注释] */
  examples: [string, string][]
  /** 注意事项 */
  note?: string
  /** 危险说明；有值即视为危险命令 */
  danger?: string
}

/** 构造命令时的可选字段 */
export interface CmdExtra {
  /** 别名 */
  aliases?: string[]
  /** 注意事项 */
  note?: string
  /** 危险说明 */
  danger?: string
}

/**
 * 构造一条命令记录，省去重复的字段名。
 *
 * @param cat 分类
 * @param name 命令名
 * @param brief 一句话作用
 * @param syntax 语法
 * @param options 常用选项
 * @param examples 示例
 * @param extra 可选：别名、注意事项、危险说明
 * @returns 命令记录
 * @example c(CAT_FILE, 'pwd', '显示当前目录', 'pwd', [['-P', '解析符号链接']], [['pwd', '看我在哪']])
 */
export function c(cat: Category, name: string, brief: string, syntax: string, options: [string, string][], examples: [string, string][], extra: CmdExtra = {}): LinuxCmd {
  return { name, aliases: extra.aliases ?? [], cat, brief, syntax, options, examples, note: extra.note, danger: extra.danger }
}
