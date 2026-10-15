<script setup lang="ts">
// 模型选择器：触发器可通过默认插槽自定义（默认是 AI 图标按钮），点开底部弹层选模型；状态见 docs/design/model-picker.md
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { closeNotify, showNotify, showToast } from 'vant'
import { useModelsStore } from '@/stores/models'
import { useAiProviders } from '@/native/useAiProviders'
import { useModelChoice } from '@/native/useModelChoice'
import type { ToolModelOption } from '@/tools/registry'
import ModelPickerList from './ModelPickerList.vue'
import {
  AI_CENTER_PATH,
  MSG_DOWNLOADING,
  buildItems,
  handlePick,
  type PickerItem,
} from './modelPicker'

/** 顶部提示停留时长（毫秒） */
const NOTIFY_MS = 4000

/** 工具 id 与它声明的可选模型 */
const props = defineProps<{ toolId: string; models: ToolModelOption[] }>()

/** 路由器 */
const router = useRouter()
/** 本机 AI 探测 */
const ai = useAiProviders()
/** 当前工具的选择结果 */
const { choice, set } = useModelChoice(props.toolId)
/** 弹层是否打开 */
const open = ref(false)
/** 模型状态源：只读，下载由推送实时更新 */
const store = useModelsStore()

/** 全部行 */
const items = computed<PickerItem[]>(() =>
  buildItems(props.models, {
    statuses: store.byId,
    providerIds: ai.providers.value.filter((p) => p.available).map((p) => p.id),
    selected: choice.value,
  }),
)
/** 按钮上显示的简称：当前选中模型名，没有则「模型」 */
const label = computed(() => {
  const cur = items.value.find((i) => i.id === choice.value)
  return cur ? cur.title.split('-').slice(1).join('-') : '模型'
})
watch(open, (v) => {
  if (v) void ai.refresh()
})

/** 底部按钮文案：去 AI 中心 */
const MANAGE_TEXT = '查看Ai中心'

/** 点底部按钮：关面板并去 AI 中心 */
function goCenter(): void {
  open.value = false
  void router.push(AI_CENTER_PATH)
}

/** 弹出可点击的顶部提示，点击去 AI 中心 */
function notifyDownloading(): void {
  open.value = false
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
      set(id)
      open.value = false
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
  <!-- 触发器插槽：label 为当前模型简称，show 打开弹层；不传则渲染 AI 图标按钮 -->
  <slot :label="label" :show="() => (open = true)">
    <van-button type="primary" round size="small" :aria-label="`选择模型：${label}`" @click.stop="open = true">
      <i-arkli-ai class="mp-trigger__icon" />
    </van-button>
  </slot>
  <!-- 底部按钮用 cancel 插槽自定义 click，不监听 @cancel；.stop 防冒泡到 van 自带的取消处理，右上角关闭图标只关面板 -->
  <van-action-sheet v-model:show="open" teleport="body" title="选择模型">
    <model-picker-list :items="items" @pick="onPick" />
    <template #cancel>
      <div class="mp-manage" role="button" @click.stop="goCenter">
        <span>{{ MANAGE_TEXT }}</span>
        <van-icon name="arrow" />
      </div>
    </template>
  </van-action-sheet>
</template>

<style lang="scss" scoped>
/* 底部「查看Ai中心」按钮（文字 + 右箭头，danger 红）：铺满 van 的取消按钮区域，保证整块可点 */
.mp-manage {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  width: 100%;
  height: 100%;
  color: var(--van-danger-color); /* 整体 danger 红：文字与箭头 */
}

/* 触发器里的 AI 图标：跟随按钮文字色 */
.mp-trigger__icon {
  font-size: 18px;
  vertical-align: middle;
}
</style>
