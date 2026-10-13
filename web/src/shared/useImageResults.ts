import { getCurrentScope, onScopeDispose, ref, shallowRef } from 'vue'
import { showFailToast, showSuccessToast, showToast } from 'vant'
import { ImageTooLargeError, saveBlobs } from './image-io'

/** 处理产物 */
export interface ResultItem {
  /** 唯一编号，用作列表 key */
  id: number
  /** 文件名（含扩展名） */
  name: string
  /** 内容 */
  blob: Blob
  /** 预览用 ObjectURL，销毁时自动回收 */
  url: string
  /** 宽 */
  width: number
  /** 高 */
  height: number
  /** 附加说明，如“压缩前 1.2 MB，-62%” */
  note?: string
}

/** worker 返回的产物（url、id 由本模块补） */
export type ResultDraft = Omit<ResultItem, 'id' | 'url'>

/** 单个输入处理失败时的提示 */
const FAIL_TEXT = '处理失败'

/**
 * 图片工具的“批处理 + 结果列表 + 保存”公共状态。
 * 串行处理（并发 1，防低端机爆内存），结果的 ObjectURL 在清空或作用域销毁时回收。
 *
 * @returns results 结果；busy 是否处理中；progress 如 `2/5`；saving 是否保存中；process / saveAll / clear
 * @example
 * const { results, process, saveAll } = useImageResults()
 * await process(images, async (img) => ({ name: 'a.jpg', blob, width: 1, height: 1 }))
 * await saveAll()
 */
export function useImageResults() {
  /** 当前结果 */
  const results = shallowRef<ResultItem[]>([])
  /** 是否处理中 */
  const busy = ref(false)
  /** 处理进度文案，空串表示无 */
  const progress = ref('')
  /** 是否保存中 */
  const saving = ref(false)
  /** 自增编号 */
  let seq = 0

  /** 清空结果并回收 ObjectURL */
  function clear(): void {
    results.value.forEach((r) => URL.revokeObjectURL(r.url))
    results.value = []
  }

  /**
   * 串行处理一批输入。单个失败不影响其余；超限图片给出“请先缩小”提示。
   *
   * @param inputs 输入列表
   * @param worker 处理单个输入，可返回一个或多个产物
   * @returns 成功的产物数
   */
  async function process<T>(inputs: T[], worker: (input: T, index: number) => Promise<ResultDraft | ResultDraft[]>): Promise<number> {
    if (busy.value) return 0
    clear()
    busy.value = true
    const out: ResultItem[] = []
    let failed = 0
    let tooLarge = false
    try {
      for (let i = 0; i < inputs.length; i++) {
        progress.value = `${i + 1}/${inputs.length}`
        try {
          const drafts = await worker(inputs[i], i)
          for (const d of Array.isArray(drafts) ? drafts : [drafts]) {
            out.push({ ...d, id: ++seq, url: URL.createObjectURL(d.blob) })
          }
        } catch (e) {
          failed++
          if (e instanceof ImageTooLargeError) tooLarge = true
        }
        results.value = out.slice()
      }
    } finally {
      busy.value = false
      progress.value = ''
    }
    if (tooLarge) showToast('图片过大，请先缩小')
    else if (failed) showFailToast(`${FAIL_TEXT} ${failed} 张`)
    return out.length
  }

  /** 保存全部结果：原生存相册 / 浏览器下载，并 toast 反馈 */
  async function saveAll(): Promise<void> {
    if (saving.value || results.value.length === 0) return
    saving.value = true
    try {
      const total = results.value.length
      const res = await saveBlobs(
        results.value.map((r) => ({ name: r.name, blob: r.blob })),
        (done) => {
          progress.value = `${done}/${total}`
        },
      )
      showSuccessToast(res.mode === 'native' ? `已保存 ${res.saved} 张到相册` : `已下载 ${res.saved} 张`)
    } catch (e) {
      const msg = (e as { message?: string }).message
      showFailToast(msg ? `保存失败：${msg}` : '保存失败')
    } finally {
      saving.value = false
      progress.value = ''
    }
  }

  if (getCurrentScope()) onScopeDispose(clear)

  return { results, busy, progress, saving, process, saveAll, clear }
}
