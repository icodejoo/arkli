<script setup lang="ts">
// “添加到桌面”弹窗：首页长按与工具页胶囊菜单共用
import { computed } from 'vue'
import { showToast } from 'vant'
import { pinToolShortcut } from '@/native/shortcut'
import { toolIcon } from '@/views/toolIcons'
import {
  PIN_CANCEL_TEXT,
  PIN_SHEET_ACTIONS,
  formatPinDescription,
  pinErrorToast,
  pinResultToast,
  type PinToolTarget,
} from './pinToolSheet'

/** 是否显示（v-model:show） */
const show = defineModel<boolean>('show', { default: false })
/** 要固定的工具 */
const props = defineProps<{ tool?: PinToolTarget | null }>()

/** 顶部描述：工具图标 + 名称 */
const description = computed(() => formatPinDescription(props.tool, toolIcon))

/** 选择“添加到桌面”：请求系统固定并提示结果 */
async function onSelect(): Promise<void> {
  const t = props.tool
  show.value = false
  if (!t) return
  try {
    const r = await pinToolShortcut({ label: t.name, icon: toolIcon(t.id), toolId: t.id })
    showToast(pinResultToast(r))
  } catch (e) {
    showToast(pinErrorToast(e))
  }
}
</script>

<template>
  <van-action-sheet
    v-model:show="show"
    :actions="PIN_SHEET_ACTIONS"
    :description="description"
    :cancel-text="PIN_CANCEL_TEXT"
    close-on-click-action
    @select="onSelect"
  />
</template>
