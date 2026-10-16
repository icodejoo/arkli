// 模型预热与卸载接线：跟随所选提供者，进入时预热、切换时先卸旧的、离开时卸载回收内存（状态机见 warmup.ts）
import { onActivated, onBeforeUnmount, onDeactivated, onMounted, watch, type Ref } from 'vue'
import { aiUnload, aiWarmup } from '@/native/ai'
import { createProviderWarmup, type ProviderWarmup } from './warmup'

/**
 * 翻译页用：页面活跃且所选模型已安装时预热当前提供者；换提供者时先卸载旧的再预热新的；
 * 停用与卸载时取消并卸载当前的。页面停用期间状态变化（如下载完成）不会触发预热。
 *
 * @param provider 当前所选模型对应的提供者 id；未知（还没探测到）为 undefined
 * @param ready 所选模型是否已安装
 * @returns 预热器（页面一般不用）
 * @example useModelWarmup(providerId, modelReady)
 */
export function useModelWarmup(provider: Ref<string | undefined>, ready: Ref<boolean>): ProviderWarmup {
  const w = createProviderWarmup({ warmup: (id, s) => aiWarmup(id, s), unload: (id) => aiUnload(id) })
  /** 页面是否处于活跃（挂载或激活，且未停用） */
  let active = false
  /** 进入：标记活跃并按当前状态同步 */
  const enter = (): void => {
    active = true
    w.sync(provider.value, ready.value)
  }
  /** 离开：标记不活跃并释放 */
  const leave = (): void => {
    active = false
    w.release()
  }
  onMounted(enter)
  onActivated(enter)
  watch([provider, ready], () => {
    if (active) w.sync(provider.value, ready.value)
  })
  onDeactivated(leave)
  onBeforeUnmount(leave)
  return w
}
