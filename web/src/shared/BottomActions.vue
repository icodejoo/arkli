<script setup lang="ts">
// 通用底部动作栏：内置动作由 bottomActions.ts 的注册表驱动（默认全关），`actions` 或旧布尔 props 启用；
// 每项可用同名插槽（带作用域）整项替换；默认插槽放额外项（摆在图标项与主按钮之间）；图标项过多自动收进「更多」。
// 需要更自由的布局就直接用官方 van-action-bar。
import { computed, ref } from 'vue'
import {
  BOTTOM_ACTION_EMITS,
  BOTTOM_ACTION_EVENT,
  DEFAULT_MAX_VISIBLE,
  MORE_ICON,
  MORE_TEXT,
  normalizeActions,
  splitCollapsed,
  type BottomActionKey,
  type BottomActionSlotScope,
  type BottomActionsInput,
  type MainType,
  type NormalizedAction,
} from './bottomActions'
import { resolveActionIcon } from './bottomActionIcons'
import { useFloatBusy } from './useFloatPause'

/** 危险色（danger 项与「更多」里的危险项） */
const DANGER_COLOR = 'var(--van-danger-color)'
/** 主按钮加载态类名 */
const MAIN_LOADING_CLASS = 'ba-main--loading'
/** 主按钮 key */
const MAIN_KEY = 'main'

/**
 * 属性：
 * - actions 启用的内置项：`['copy', 'save']` 或 `{ save: true, delete: { disabled: busy, text: '删除所选', color: '#f00' }, main: { loading: busy } }`；键见 BOTTOM_ACTION_REGISTRY
 * - ai / album / photo / main 旧布尔别名，等价于在 actions 里启用对应项；ai 项内容走 `#ai` 插槽（放 model-picker）
 * - mainLoading 主按钮加载中（心跳折线动画，不自动禁用、不吞点击）
 * - mainText 主按钮文案，默认「生成」
 * - mainType 主按钮配色，默认 primary
 * - mainColor 主按钮背景色（纯色或渐变），不传按 mainType
 * - iconColor 图标按钮前景色，不传用主题色
 * - disabled 按项禁用，如 `{ album: true, main: busy }`
 * - maxVisible 图标项（不含 ai / main）最多同时显示几个，超出收进「更多」；默认 4，0 / Infinity 关闭收纳
 *
 * 事件：每个启用项点击发同名事件（`@save`、`@copy`、`@album`、`@main` …），并统一再发 `action`（参数为 key）。
 * 插槽：任一内置 key 同名插槽整项替换（作用域见 BottomActionSlotScope）；default 额外项。
 *
 * @example <bottom-actions :actions="['copy', 'save']" main main-text="翻译" :disabled="{ main: !ok }" @copy="copy" @save="save" @main="go"><template #ai><model-picker variant="bar" /></template></bottom-actions>
 * @example <bottom-actions main main-text="生成中" :main-loading="busy" @main="run" />
 * @example <bottom-actions :actions="{ main: { text: '处理中', loading: busy } }" @main="run" />
 */
const props = withDefaults(
  defineProps<{
    actions?: BottomActionsInput
    ai?: boolean
    album?: boolean
    photo?: boolean
    main?: boolean
    mainLoading?: boolean
    mainText?: string
    mainType?: MainType
    mainColor?: string
    iconColor?: string
    disabled?: Partial<Record<BottomActionKey, boolean>>
    maxVisible?: number
  }>(),
  { mainLoading: false, mainType: 'primary', disabled: () => ({}), maxVisible: DEFAULT_MAX_VISIBLE },
)
// 运行时声明：事件名取自注册表（各项同名事件 + action），保证 @save / @copy 等具名事件可用
const emit = defineEmits([...BOTTOM_ACTION_EMITS])

/** 归一化后的启用项（按注册表顺序） */
const items = computed(() =>
  normalizeActions(props.actions, {
    flags: { ai: props.ai, album: props.album, photo: props.photo, main: props.main },
    mainLoading: props.mainLoading,
    mainText: props.mainText,
    mainColor: props.mainColor,
    iconColor: props.iconColor,
    disabled: props.disabled,
  }),
)
// 主按钮加载中即有不可暂停的任务：自动汇报给浮窗（不在工具页内时无动作）
useFloatBusy(() => items.value.some((i) => i.loading))
/** 是否启用 ai 项 */
const hasAi = computed(() => items.value.some((i) => i.key === 'ai'))
/** 主按钮项 */
const mainItem = computed(() => items.value.find((i) => i.key === MAIN_KEY))
/** 图标项收纳结果 */
const collapsed = computed(() => splitCollapsed(items.value, props.maxVisible))
/** 「更多」弹层是否显示 */
const moreShow = ref(false)

/** 触发某项事件：同名事件 + 统一 action */
function fire(key: BottomActionKey): void {
  emit(key)
  emit(BOTTOM_ACTION_EVENT, key)
}
/** 某项的插槽作用域 */
function scopeOf(item: NormalizedAction): BottomActionSlotScope {
  return {
    text: item.text,
    icon: item.icon,
    color: item.color,
    disabled: item.disabled,
    loading: item.loading,
    click: () => fire(item.key),
  }
}
/** 图标项前景色：显式颜色优先，危险项默认红 */
function colorOf(item: NormalizedAction): string | undefined {
  return item.color ?? (item.tone === 'danger' ? DANGER_COLOR : undefined)
}
/** 「更多」弹层的选项 */
const sheetActions = computed(() =>
  collapsed.value.more.map((i) => ({ name: i.text, key: i.key, disabled: i.disabled, color: i.tone === 'danger' ? DANGER_COLOR : i.color })),
)
/** 点「更多」里的一项 */
function onSelect(a: { key: BottomActionKey }): void {
  moreShow.value = false
  fire(a.key)
}
</script>

<template>
  <van-action-bar class="ba" placeholder :safe-area-inset-bottom="false">
    <slot v-if="hasAi" name="ai" />
    <template v-for="item in collapsed.visible" :key="item.key">
      <slot :name="item.key" v-bind="scopeOf(item)">
        <van-action-bar-icon
          plain
          type="primary"
          :icon="resolveActionIcon(item.icon) ? undefined : item.icon"
          :color="colorOf(item)"
          :text="item.text"
          :disabled="item.disabled"
          @click="fire(item.key)"
        >
          <template v-if="resolveActionIcon(item.icon)" #icon><component :is="resolveActionIcon(item.icon)" class="ba-icon" /></template>
        </van-action-bar-icon>
      </slot>
    </template>
    <template v-if="collapsed.more.length">
      <van-action-bar-icon :color="iconColor" :text="MORE_TEXT" @click="moreShow = true">
        <template #icon><component :is="resolveActionIcon(MORE_ICON)" class="ba-icon" /></template>
      </van-action-bar-icon>
      <van-action-sheet v-model:show="moreShow" teleport="body" :actions="sheetActions" cancel-text="取消" close-on-click-action @select="onSelect" />
    </template>
    <slot />
    <template v-if="mainItem">
      <slot name="main" v-bind="scopeOf(mainItem)">
        <van-action-bar-button
          :class="mainItem.loading ? MAIN_LOADING_CLASS : undefined"
          :aria-busy="mainItem.loading ? 'true' : undefined"
          :type="mainType"
          :color="mainItem.color"
          :text="mainItem.text"
          :disabled="mainItem.disabled"
          @click="fire('main')"
        />
      </slot>
    </template>
  </van-action-bar>
</template>

<style lang="scss" scoped>
/* 心电图折线动画参数：时长、周期宽度、不透明度 */
$ba-ecg-duration: 1.4s; // 循环周期约 1.4s 一拍
$ba-ecg-width: 120px; // 单个周期宽度，位移与 background-size 保持一致以首尾无缝循环
$ba-ecg-opacity: 0.65; // 正常态心跳折线不透明度（白色半透明，适配各底色与亮暗主题且不抢文字）
$ba-ecg-disabled-opacity: 0.35; // 禁用态下进一步压暗，避免与 0.5 opacity 叠加后刺眼

/* 内联心电图 SVG：基线居中 (y=16)，P-Q-R-S-T 典型波形，首尾水平高度一致保证 repeat-x 完美衔接 */
$ba-ecg-svg: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 32' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M0 16 h32 l4 -3 l4 3 h6 l3 2 l6 -14 l6 24 l6 -12 h6 l6 -5 l8 5 h33'/%3E%3C/svg%3E";

/* 避开手势条 */
.ba {
  padding-bottom: var(--safe-bottom);
}
/* 自定义（Lucide）图标：与 vant 图标区同大，颜色跟随文字色 */
.ba-icon {
  width: 1em;
  height: 1em;
}

/* 主按钮心跳加载态 */
.ba-main--loading {
  position: relative;
  overflow: hidden;

  /* 文字层提升至伪元素之上，确保文字清晰可读 */
  :deep(.van-button__content) {
    position: relative;
    z-index: 1;
  }

  /* 心跳折线背景层：从右往左无缝扫过，pointer-events: none 防止阻挡点击事件 */
  &::after {
    content: '';
    position: absolute;
    inset: 0;
    pointer-events: none;
    background-image: url($ba-ecg-svg);
    background-repeat: repeat-x;
    background-size: $ba-ecg-width 100%;
    background-position: 0 50%;
    opacity: $ba-ecg-opacity;
    animation: ba-ecg-sweep $ba-ecg-duration linear infinite;
  }

  /* 禁用态下动画继续但适当降亮 */
  &.van-button--disabled::after,
  &:disabled::after {
    opacity: $ba-ecg-disabled-opacity;
  }
}

/* 心电图自右向左平移关键帧（位移一个完整周期宽度以实现无缝循环） */
@keyframes ba-ecg-sweep {
  from {
    background-position: 0 50%;
  }
  to {
    background-position: -$ba-ecg-width 50%;
  }
}

/* 用户偏好减少动画时：静止展示心跳折线，避免视觉眩晕 */
@media (prefers-reduced-motion: reduce) {
  .ba-main--loading::after {
    animation: none;
  }
}
</style>
