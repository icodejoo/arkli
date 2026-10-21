<script setup lang="ts">
// 工具宫格：首页、AI 页、收藏页共用；点击进入 /tool/:id，长按（仅 App 内）可添加到桌面
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { isNativeAvailable } from '@/native/bridge'
import PinToolSheet from '@/shared/PinToolSheet.vue'
import type { ToolMeta } from '@/tools/registry'
import { toolIcon } from './toolIcons'
import { GRID_COLUMNS } from './toolGrid'
import { createLongPress } from './useLongPress'

/** 要展示的工具 */
const props = defineProps<{ tools: ToolMeta[] }>()

/** 路由 */
const router = useRouter()
/** 长按菜单是否显示 */
const sheetShow = ref(false)
/** 长按选中的工具 id */
const pressedId = ref('')
/** 长按选中的工具 */
const pressed = computed(() => props.tools.find((t) => t.id === pressedId.value))
/** 长按识别：只在 App 内启用，浏览器里没有桌面可加 */
const longPress = createLongPress((id) => {
  if (!isNativeAvailable()) return
  pressedId.value = id
  sheetShow.value = true
})

/** 点击工具：刚长按过就吞掉这次点击，否则进入工具页 */
function open(id: string): void {
  if (longPress.consumeClick()) return
  void router.push(`/tool/${id}`)
}
</script>

<template>
  <div class="tool-grid" :style="{ '--cols': GRID_COLUMNS }">
    <div
      v-for="t in tools"
      :key="t.id"
      class="tool-grid__item"
      @click="open(t.id)"
      @touchstart.passive="longPress.start($event, t.id)"
      @touchmove.passive="longPress.move($event)"
      @touchend="longPress.end()"
      @touchcancel="longPress.end()"
      @contextmenu.prevent
    >
      <span class="tool-grid__icon">{{ toolIcon(t.id) }}</span>
      <span class="tool-grid__name">{{ t.name }}</span>
    </div>
  </div>
  <pin-tool-sheet v-model:show="sheetShow" :tool="pressed" />
</template>

<style lang="scss" scoped>
// 宫格整体做成一张圆角卡片，格子之间靠留白区分
.tool-grid {
  display: grid;
  grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
  overflow: hidden;
  border-radius: var(--van-radius-lg);
  background: var(--c-surface);

  // 每格 1:1，内容居中；长按不选中文字、不弹系统菜单
  &__item {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    aspect-ratio: 1 / 1;
    padding: $space-2;
    box-sizing: border-box;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;

    &:active {
      background: var(--c-surface-active);
    }

    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
  }

  // 图标固定占位，不随名称行数变化
  &__icon {
    flex: none;
    width: 32px;
    height: 32px;
    font-size: 28px;
    line-height: 32px;
    text-align: center;
  }

  // 名称固定两行高度（12px × 1.3 × 2），单行也占满，图标位置才不会漂
  &__name {
    flex: none;
    height: 31.2px;
    margin-top: $space-2;
    font-size: 12px;
    line-height: 1.3;
    text-align: center;
    color: var(--c-text);
    // 名称最多两行，超出省略
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
}
</style>
