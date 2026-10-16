<script setup lang="ts">
// 模型选择器的一个分组：一个工具的 AI 目录 + 列表 + 点击处理。多类模型（如翻译 + 文字识别）各占一个分组，各记各的选择
import { computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { closeNotify, showNotify, showToast } from 'vant'
import { useModelsStore } from '@/stores/models'
import { useAiCatalog } from '@/native/useAiCatalog'
import ModelPickerList from './ModelPickerList.vue'
import { AI_CENTER_PATH, MSG_DOWNLOADING, buildItems, handlePick, type PickerItem } from './modelPicker'

/** 顶部提示停留时长（毫秒） */
const NOTIFY_MS = 4000

/** 分组所属工具 id、可选的分组标题（单分组时不传）、弹层是否打开（打开时重新探测） */
const props = defineProps<{ toolId: string; title?: string; open: boolean }>()
/** 选中了某项 / 弹出了下载提示（后者必须关弹层） */
const emit = defineEmits<{ picked: []; close: [] }>()

/** 路由器 */
const router = useRouter()
/** 该工具的 AI 目录与当前选择 */
const catalog = useAiCatalog(props.toolId)
/** 模型 store：选择器只用它触发下载，状态由推送实时更新 */
const store = useModelsStore()
/** 全部行 */
const items = computed<PickerItem[]>(() => buildItems(catalog.items.value, catalog.choice.value))

watch(
  () => props.open,
  (v) => {
    if (v) void catalog.refresh()
  },
)

/** 弹出可点击的顶部提示，点击去 AI 中心 */
function notifyDownloading(): void {
  emit('close')
  showNotify({
    type: 'primary',
    message: MSG_DOWNLOADING,
    duration: NOTIFY_MS,
    onClick: () => {
      closeNotify()
      void router.push(AI_CENTER_PATH)
    },
  })
}

/** 点击一行 */
async function onPick(item: PickerItem): Promise<void> {
  await handlePick(item, {
    select: (id) => {
      catalog.set(id)
      emit('picked')
    },
    download: async (id) => {
      try {
        await store.download(id)
      } catch {
        showToast('启动下载失败')
      }
    },
    notifyDownloading,
    toast: (m) => showToast(m),
  })
}
</script>

<template>
  <section class="mps">
    <h4 v-if="title" class="mps__title">{{ title }}</h4>
    <model-picker-list :items="items" @pick="onPick" />
  </section>
</template>

<style lang="scss" scoped>
/* 分组标题：小号灰字，与列表行区分 */
.mps__title {
  margin: 0;
  padding: $space-2 $space-4 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--c-text-muted);
}
</style>
