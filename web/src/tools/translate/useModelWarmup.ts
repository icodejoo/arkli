// 翻译模型的预热与卸载接线：进入预热、离开/卸载时回收内存（状态机见 warmup.ts）
import { onActivated, onBeforeUnmount, onDeactivated, onMounted, watch, type Ref } from 'vue'
import { aiUnload, aiWarmup } from '@/native/ai'
import { NLLB_PROVIDER } from './logic'
import { createWarmup, type WarmupController } from './warmup'

/**
 * 翻译页用：模型已安装时在挂载/激活/变为已安装时预热；停用与卸载时取消并卸载。
 *
 * @param ready 本地模型是否已安装
 * @returns 控制器（页面一般不用）
 * @example useModelWarmup(modelReady)
 */
export function useModelWarmup(ready: Ref<boolean>): WarmupController {
  const w = createWarmup({ warmup: (s) => aiWarmup(NLLB_PROVIDER, s), unload: () => aiUnload(NLLB_PROVIDER) })
  const tryWarm = (): void => {
    if (ready.value) w.warm()
  }
  onMounted(tryWarm)
  onActivated(tryWarm)
  watch(ready, tryWarm)
  onDeactivated(w.release)
  onBeforeUnmount(w.release)
  return w
}
