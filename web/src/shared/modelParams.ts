/**
 * 模型可调参数面板的纯逻辑：映射转换、数值格式化、修改判定等。
 */
import type { AiParamSpec, AiProviderInfo, AiTask } from '@/native/ai'
import { TASK_LABELS } from './aiCatalog'

/** 会话级参数需重载的提示文案 */
export const SESSION_RELOAD_HINT = '下次使用时重新加载（约 3 秒）'

/** 页面自带设置功能优先的提示文案 */
export const PAGE_OVERRIDE_HINT = '页面自带设置的功能以页面为准'

/** 高级折叠面板标题 */
export const ADVANCED_COLLAPSE_TITLE = '高级设置'

/** 恢复全部默认按钮文案 */
export const RESET_ALL_TEXT = '恢复默认'

/** 读取参数失败提示 */
export const LOAD_FAILED_MSG = '读取参数失败'

/** 设置失败提示 */
export const SET_FAILED_MSG = '参数设置失败'

/** 重置失败提示 */
export const RESET_FAILED_MSG = '恢复默认失败'

/** 单项重置按钮的标签 */
export const RESET_ITEM_LABEL = '恢复此项默认值'

/** 适用范围文本前缀 */
export const APPLY_TO_PREFIX = '只对：'

/** 适用范围文本后缀 */
export const APPLY_TO_SUFFIX = ' 生效'

/** 浮点数比较容差 */
const FLOAT_EPSILON = 1e-6

/**
 * 格式化任务/预设适用范围说明。
 *
 * @param applyTo 任务名或预设名列表
 * @returns 格式化后的提示文字，为空或空数组时返回空字符串
 * @example formatApplyToText(['prompt']) // '只对：问答 生效'
 * @example formatApplyToText(['summarize', 'rewrite']) // '只对：摘要、改写 生效'
 */
export function formatApplyToText(applyTo?: string[]): string {
  if (!applyTo || applyTo.length === 0) return ''
  const names = applyTo.map((item) => TASK_LABELS[item as AiTask] ?? item).join('、')
  return `${APPLY_TO_PREFIX}${names}${APPLY_TO_SUFFIX}`
}

/**
 * 判断参数当前值是否与默认值不同。
 *
 * @param spec 参数定义
 * @param value 当前数值
 * @returns 发生了修改返回 true
 * @example isModified(spec, 0.8) // true
 */
export function isModified(spec: AiParamSpec, value: number | undefined): boolean {
  if (value === undefined) return false
  return Math.abs(value - spec.default) > FLOAT_EPSILON
}

/**
 * 求 select 当前值对应的选项下标：有 `optionValues` 时按真实值查，否则值本身就是下标。
 *
 * @param spec 参数定义
 * @param value 当前数值
 * @returns 选项下标；真实值不在表里为 -1
 * @example selectIndex({ ...spec, optionValues: [1, 2, 4] }, 4) // 2
 */
export function selectIndex(spec: AiParamSpec, value: number): number {
  return spec.optionValues ? spec.optionValues.indexOf(value) : Math.round(value)
}

/**
 * 取 select 第 idx 档要提交的值：有 `optionValues` 时为真实值，否则为下标本身。
 *
 * @param spec 参数定义
 * @param idx 选项下标
 * @returns 要提交给原生的数值
 * @example selectValue({ ...spec, optionValues: [1, 2, 4] }, 2) // 4
 */
export function selectValue(spec: AiParamSpec, idx: number): number {
  return spec.optionValues?.[idx] ?? idx
}

/**
 * 格式化展示参数数值。
 *
 * @param spec 参数定义
 * @param value 当前数值
 * @returns 格式化后的文本
 * @example formatParamValue(sliderSpec, 0.70000001) // '0.7'
 * @example formatParamValue(selectSpec, 1) // '高性能'
 */
export function formatParamValue(spec: AiParamSpec, value: number | undefined): string {
  const v = value ?? spec.default
  if (spec.kind === 'select') {
    const idx = selectIndex(spec, v)
    return spec.options?.[idx] ?? String(v)
  }
  const stepStr = String(spec.step)
  const dotIndex = stepStr.indexOf('.')
  const decimals = dotIndex >= 0 ? stepStr.length - dotIndex - 1 : 0
  return Number(v.toFixed(decimals)).toString()
}

/**
 * 将参数规格列表按是否属于高级设置拆分为两组。
 *
 * @param specs 原始参数规格列表
 * @returns 普通参数列表与高级参数列表
 * @example const { basic, advanced } = splitSpecs(specs)
 */
export function splitSpecs(specs: AiParamSpec[]): { basic: AiParamSpec[]; advanced: AiParamSpec[] } {
  return { basic: specs.filter((s) => !s.advanced), advanced: specs.filter((s) => s.advanced) }
}

/**
 * 取某清单模型对应的、声明了可调参数的提供者（按 `provider.modelId` 关联）。
 *
 * @param providers 全部提供者
 * @param modelId 清单模型 id
 * @returns 有 `params` 的提供者；语音识别、数据包等没有则为空数组
 * @example paramProvidersOf(providers, 'qwen35-0.8b-mnn-q4').map((p) => p.id) // ['local-qwen']
 */
export function paramProvidersOf(providers: AiProviderInfo[], modelId: string): AiProviderInfo[] {
  return providers.filter((p) => p.modelId === modelId && !!p.params?.length)
}
