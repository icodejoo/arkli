// 翻译：语言与常量
import type { TranslateLang } from '@/native/ai'

/** 翻译文本长度上限（本地模型每句耗时数秒，限制长度避免等太久） */
export const TEXT_MAX = 2000

/** 默认源语言 */
export const DEFAULT_SRC: TranslateLang = 'en'
/** 默认目标语言 */
export const DEFAULT_TGT: TranslateLang = 'zh-CN'
/** 语言选择在 localStorage 里的键 */
export const LANGS_STORAGE_KEY = 'arkli:translate:langs'
/** 本地翻译模型的清单 id（与 registry 的 L1 一致） */
export const NLLB_MODEL_ID = 'nllb600m-un6-ccm-int4'
