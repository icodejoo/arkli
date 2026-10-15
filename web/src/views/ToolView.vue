<script setup lang="ts">
// 工具容器页：顶部导航栏 + 内容区（安全区内边距），按路由 id 异步加载工具组件
import { computed, defineAsyncComponent, watchEffect, type Component } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showToast } from 'vant'
import CameraIcon from '~icons/cil/camera?width=1em&height=1em'
import KeyboardIcon from '~icons/cil/keyboard?width=1em&height=1em'
import { MODE_CAMERA, MODE_QUERY, TAG_AI, findTool } from '@/tools/registry'
import ModelPicker from '@/shared/ModelPicker.vue'
import { useToolsStore } from '@/stores/tools'
import { useFavoritesStore } from '@/stores/favorites'

/** 同一个 ToolView 里最多同时保活几个工具：从取色器跳颜色助手再返回时，取色器的状态（选好的图片、主色、倍数）得以保留 */
const KEEP_ALIVE_MAX = 3
/** 工具 id 到异步组件的缓存：重复 defineAsyncComponent 会得到不同的组件对象，keep-alive 就命中不了 */
const asyncTools = new Map<string, Component>()

/**
 * 取某个工具的异步组件（同一 id 始终返回同一个对象）。
 *
 * @param id 工具 id
 * @param load 动态加载函数
 * @returns 异步组件
 */
function asyncToolOf(id: string, load: () => Promise<unknown>): Component {
  let c = asyncTools.get(id)
  if (!c) {
    c = defineAsyncComponent(load as Parameters<typeof defineAsyncComponent>[0])
    asyncTools.set(id, c)
  }
  return c
}

/** 路由参数：工具 id */
const props = defineProps<{ id: string }>()

/** 路由器 */
const router = useRouter()
/** 工具 store */
const store = useToolsStore()
/** 收藏 store */
const favorites = useFavoritesStore()
/** 当前工具是否已收藏 */
const starred = computed(() => favorites.has(props.id))
/** 当前工具元信息 */
const meta = computed(() => findTool(props.id))
/** 当前路由 */
const route = useRoute()
/** 工具是否支持摄像头模式切换 */
const hasCamera = computed(() => !!meta.value?.camera)
/** 当前是否在拍照识别模式 */
const cameraOn = computed(() => route.query[MODE_QUERY] === MODE_CAMERA)
/** 带 ai 标签且声明了模型的工具才在标题栏显示模型选择器；摄像头工具与声明 pickerInPage 的工具把选择器放在页面里 */
const showPicker = computed(() => !!meta.value?.tags?.includes(TAG_AI) && !!meta.value.models?.length && !hasCamera.value && !meta.value.pickerInPage)

/** 在普通模式与拍照识别模式间切换（replace，不堆历史） */
function toggleCamera(): void {
  const query = { ...route.query }
  if (cameraOn.value) delete query[MODE_QUERY]
  else query[MODE_QUERY] = MODE_CAMERA
  router.replace({ query })
}
/** 当前工具的异步组件；id 不存在时为 null。每个工具只建一次异步包装，keep-alive 才认得出「同一个工具」 */
const ToolComponent = computed(() => (meta.value ? asyncToolOf(meta.value.id, meta.value.load) : null))

/** 切换收藏并提示 */
function toggleStar(): void {
  showToast(favorites.toggle(props.id) ? '已收藏' : '已取消收藏')
}

/** 返回上一页；没有历史（如直接打开深链）时回首页 */
function goBack(): void {
  if (window.history.length > 1) router.back()
  else router.replace('/')
}

// 打开有效工具时记入最近使用
watchEffect(() => {
  if (meta.value) store.markUsed(meta.value.id)
})
</script>

<template>
  <div class="shell">
    <van-nav-bar
      class="shell__nav"
      :title="meta?.name ?? '未找到工具'"
      left-arrow
      fixed
      placeholder
      safe-area-inset-top
      @click-left="goBack"
    >
      <template v-if="meta" #right>
        <model-picker v-if="showPicker" :tool-id="meta.id" :models="meta.models!" />
        <component
          :is="cameraOn ? KeyboardIcon : CameraIcon"
          v-if="hasCamera"
          :class="['shell__star', 'shell__cam']"
          role="button"
          :aria-label="cameraOn ? '切回查询' : '拍照识别'"
          @click.stop="toggleCamera"
        />
        <van-icon
          :name="starred ? 'star' : 'star-o'"
          :class="['shell__star', { 'shell__star--on': starred }]"
          :aria-label="starred ? '取消收藏' : '收藏'"
          @click.stop="toggleStar"
        />
      </template>
    </van-nav-bar>
    <main class="shell__body">
      <!-- keep-alive：工具之间互相跳转（如取色器 → 颜色助手）再返回时保留状态；离开工具页（回首页等）整个 ToolView 卸载，缓存随之释放 -->
      <keep-alive v-if="ToolComponent" :max="KEEP_ALIVE_MAX">
        <component :is="ToolComponent" :key="props.id" />
      </keep-alive>
      <van-empty v-else description="没有找到这个工具" />
    </main>
  </div>
</template>

<style lang="scss" scoped>
.shell {
  min-height: 100vh;

  // 导航栏右侧的收藏星标；已收藏用主色
  &__star {
    font-size: 22px;
    color: var(--c-text-muted);

    &--on {
      color: var(--c-primary);
    }
  }

  // 摄像头按钮与星标之间留空
  &__cam {
    margin-right: $space-3;
  }

  &__body {
    max-width: 720px;
    margin: 0 auto;
    padding: $space-4;
    padding-bottom: calc(#{$space-4} + var(--safe-bottom));
  }
}
</style>
