// 持久化 ref：初始化时读缓存，之后值一变就写回缓存。表单里“选项类”控件（单选、开关、滑块、颜色等）用它记住上次的值。
import { ref, watch, type Ref } from 'vue'
import type { ToolStorage } from './toolStorage'

/**
 * 创建一个自动持久化的 ref。
 *
 * @param store 工具的持久缓存实例（`createToolStorage('工具id')`）
 * @param key 缓存键（不含命名空间）
 * @param defaultValue 缓存里没有（或没通过校验）时的默认值
 * @param validate 可选校验：读出的值不合法（如选项已下线）返回 false，回落默认值
 * @returns 可直接 v-model 的 ref
 * @example
 * const store = createToolStorage('unit-convert')
 * const catId = usePersistedRef(store, 'catId', 'length', (v) => CATEGORIES.some((c) => c.id === v))
 */
export function usePersistedRef<T>(store: ToolStorage, key: string, defaultValue: T, validate?: (v: T) => boolean): Ref<T> {
  const saved = store.get<T>(key, defaultValue)
  const r = ref(validate && !validate(saved) ? defaultValue : saved) as Ref<T>
  watch(r, (v) => void store.set(key, v), { deep: true })
  return r
}
