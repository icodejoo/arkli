/**
 * 模型缺失闸门：模型没就绪时按钮仍可点，点击弹「没有可用模型」对话框，确认后去 AI 中心下载。
 * 只读就绪状态、只负责引导，不碰下载相关逻辑。
 */
import { showConfirmDialog } from 'vant'
import { useRouter } from 'vue-router'
import { AI_CENTER_PATH } from './modelPicker'

/** 对话框标题 */
export const GATE_TITLE = '没有可用模型'
/** 对话框正文 */
export const GATE_MESSAGE = '需要先下载模型才能使用这个功能。'
/** 确认按钮文案 */
export const GATE_CONFIRM_TEXT = '去下载'
/** 取消按钮文案 */
export const GATE_CANCEL_TEXT = '取消'

/** 闸门的外部依赖（便于测试注入） */
export interface GateDeps {
  /** 弹确认框；用户确认 resolve，取消 reject */
  confirm: (opt: { title: string; message: string; confirmButtonText: string; cancelButtonText: string }) => Promise<unknown>
  /** 跳转路由 */
  push: (path: string) => unknown
}

/**
 * 弹「没有可用模型」对话框；确认则跳转 AI 中心，取消只关闭。
 *
 * @param deps 弹窗与跳转函数
 * @returns 用户是否点了「去下载」
 * @example await promptDownloadModel({ confirm: showConfirmDialog, push: router.push })
 */
export async function promptDownloadModel(deps: GateDeps): Promise<boolean> {
  try {
    await deps.confirm({ title: GATE_TITLE, message: GATE_MESSAGE, confirmButtonText: GATE_CONFIRM_TEXT, cancelButtonText: GATE_CANCEL_TEXT })
  } catch {
    return false
  }
  void deps.push(AI_CENTER_PATH)
  return true
}

/**
 * 组合式：返回绑定当前路由器的闸门函数，须在 setup 内调用。
 *
 * @returns requireModel(ready) 就绪返回 true，未就绪弹窗并返回 false（调用方据此中止）；promptDownload() 直接弹窗
 * @example
 * const { requireModel } = useModelGate()
 * async function run() { if (!(await requireModel(modelReady.value))) return; ... }
 */
export function useModelGate() {
  /** 路由器 */
  const router = useRouter()
  /** 绑定了真实弹窗与路由的依赖 */
  const deps: GateDeps = { confirm: showConfirmDialog, push: (p) => router.push(p) }

  /** 直接弹「没有可用模型」对话框 */
  function promptDownload(): Promise<boolean> {
    return promptDownloadModel(deps)
  }

  /** 模型就绪返回 true；否则弹窗并返回 false */
  async function requireModel(ready: boolean): Promise<boolean> {
    if (ready) return true
    await promptDownload()
    return false
  }

  return { requireModel, promptDownload }
}
