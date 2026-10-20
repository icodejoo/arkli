<script setup lang="ts">
// 模型选择器：触发器可通过默认插槽自定义（默认是 AI 图标按钮），点开底部弹层选模型；行由 AI 目录按工具声明的任务算出，见 docs/design/model-picker.md
// 一个页面要选多类模型（如翻译 + 文字识别）时传 sections，每类一个分组、各记各的选择
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAiCatalog } from '@/native/useAiCatalog'
import ModelPickerSection from './ModelPickerSection.vue'
import { AI_ACTION_TEXT } from './bottomActions'
import { AI_CENTER_PATH, buildItems, type PickerItem, type PickerSection } from './modelPicker'

/** 底部按钮文案：去 AI 中心 */
const MANAGE_TEXT = '查看Ai中心'

/**
 * 单类模型传 `toolId`；多类模型传 `sections`（优先，按顺序分组显示，选中后不关弹层以便连选；触发器简称取第一组）。
 * `variant`：默认触发器样式，`button`（默认）为圆形主色按钮；`bar` 为放进 van-action-bar 的无背景「cpu-ai 图标 + Ai 文字」，图标与文字都取 AI 强调色。
 * `disabled`：禁用默认触发器（如当前模式用不到模型）；自定义触发器插槽不受影响。
 * `extra`：额外的非模型行（如对联的语料库），排在第一组模型行后面；选任何行都触发 `picked`，选的是额外行时带该行 id。
 */
const props = defineProps<{ toolId?: string; sections?: PickerSection[]; variant?: 'button' | 'bar'; disabled?: boolean; extra?: PickerItem[] }>()

/** 路由器 */
const router = useRouter()
/** 选中了某行（额外行带 id） */
const emit = defineEmits<{ picked: [extraId?: string] }>()
/** 弹层是否打开 */
const open = ref(false)
/** 点默认触发器：禁用时不打开（van-action-bar-icon 的 disabled 只置灰，不拦截点击） */
function onTrigger(): void {
  if (!props.disabled) open.value = true
}

/** 实际分组：sections 优先，否则由 toolId 生成一个无标题分组 */
const groups = computed<Array<{ toolId: string; title?: string }>>(() => {
  if (props.sections?.length) return props.sections
  return props.toolId ? [{ toolId: props.toolId }] : []
})
/** 是否多分组 */
const multi = computed(() => groups.value.length > 1)

/** 触发器简称取第一组的目录（组合式函数只能在 setup 里建一次；第一组的工具 id 在组件生命周期内不变） */
const head = useAiCatalog(groups.value[0]?.toolId ?? '')
/** 按钮上显示的简称：第一组当前选中模型名，没有则「模型」 */
const label = computed(() => {
  const cur = buildItems(head.items.value, head.choice.value).find((i) => i.id === head.choice.value)
  return cur ? cur.title.split('-').slice(1).join('-') : '模型'
})

/** 选中后：单分组关弹层；多分组留着，方便接着选下一类 */
function onPicked(extraId?: string): void {
  emit('picked', extraId)
  if (!multi.value) open.value = false
}

/** 点底部按钮：关面板并去 AI 中心 */
function goCenter(): void {
  open.value = false
  void router.push(AI_CENTER_PATH)
}
</script>

<template>
  <!-- 触发器插槽：label 为当前模型简称，show 打开弹层；不传则渲染 AI 图标按钮 -->
  <slot :label="label" :show="() => (open = true)">
    <van-action-bar-icon v-if="variant === 'bar'" class="mp-bar" :disabled="disabled" :aria-label="`选择模型：${label}`" :text="AI_ACTION_TEXT" @click.stop="onTrigger">
      <template #icon><i-arkli-cpu-ai class="mp-bar__icon" /></template>
    </van-action-bar-icon>
    <van-button v-else type="primary" round size="small" :disabled="disabled" :aria-label="`选择模型：${label}`" @click.stop="onTrigger">
      <i-arkli-ai class="mp-trigger__icon" />
    </van-button>
  </slot>
  <!-- 底部按钮用 cancel 插槽自定义 click，不监听 @cancel；.stop 防冒泡到 van 自带的取消处理，右上角关闭图标只关面板 -->
  <van-action-sheet v-model:show="open" teleport="body" title="选择模型">
    <model-picker-section
      v-for="(g, i) in groups"
      :key="g.toolId"
      :tool-id="g.toolId"
      :title="multi ? g.title : undefined"
      :open="open"
      :extra="i === 0 ? extra : undefined"
      @picked="onPicked"
      @close="open = false"
    />
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

/* 动作栏版触发器：cpu-ai 图标 + Ai 文字，整体用 AI 强调色（与底栏 AI tab 一致）；禁用时沿用 Vant 置灰 */
.mp-bar:not(.van-action-bar-icon--disabled) {
  color: var(--c-ai-accent);
}

/* 图标同样用强调色；禁用时不覆盖，沿用 Vant 的置灰色 */
.mp-bar:not(.van-action-bar-icon--disabled) .mp-bar__icon {
  color: var(--c-ai-accent);
}

.mp-bar__icon {
  font-size: 1em;
}

/* 触发器里的 AI 图标：跟随按钮文字色 */
.mp-trigger__icon {
  font-size: 18px;
  vertical-align: middle;
}
</style>
