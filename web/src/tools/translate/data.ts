// 翻译：语言与常量
import type { TranslateLang } from '@/native/ai'

/** 翻译文本长度上限（本地模型每句耗时数秒，限制长度避免等太久） */
export const TEXT_MAX = 2000

/** 默认源语言 */
export const DEFAULT_SRC: TranslateLang = 'en'
/** 默认目标语言 */
export const DEFAULT_TGT: TranslateLang = 'zh-CN'
/** 语言选择在持久缓存里的键 */
export const LANGS_KEY = 'langs'
/** 语言选择旧的 localStorage 完整键名（一次性迁移用） */
export const LEGACY_LANGS_KEY = 'arkli:translate:langs'
