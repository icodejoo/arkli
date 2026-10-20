<script setup lang="ts">
// 工具容器页：顶部导航栏 + 内容区（安全区内边距），按路由 id 异步加载工具组件
import { computed, defineAsyncComponent, nextTick, ref, watchEffect, type Component } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showToast } from 'vant'
import { isNativeAvailable } from '@/native/bridge'
import CameraIcon from '~icons/cil/camera?width=1em&height=1em'
import KeyboardIcon from '~icons/cil/keyboard?width=1em&height=1em'
import { MODE_CAMERA, MODE_QUERY, findTool } from '@/tools/registry'
import PinToolSheet from '@/shared/PinToolSheet.vue'
import { MENU_KEY_PIN, buildMenuActions } from '@/shared/pinToolSheet'
import { useToolsStore } from '@/stores/tools'
import { useFavoritesStore } from '@/stores/favorites'
import { shareApp, shareAppLink } from '@/shared/appShare'

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

/** 胶囊菜单面板是否显示 */
const shareSheet = ref(false)
/** “添加到桌面”面板是否显示 */
const pinSheet = ref(false)
/** 胶囊菜单项：两项分享，有原生宿主时再加“添加到桌面” */
const shareActions = computed(() => buildMenuActions(isNativeAvailable()))

/**
 * 选好菜单项后执行：添加到桌面先关菜单再开固定面板；链接直接发文字，安装包先导出再发。
 *
 * @param action 被选中的菜单项
 */
async function onSharePick(action: { key?: string }): Promise<void> {
  if (action.key === MENU_KEY_PIN) {
    shareSheet.value = false
    await nextTick()
    pinSheet.value = true
    return
  }
  try {
    const ok = action.key === 'apk' ? await shareApp() : await shareAppLink()
    if (!ok) showToast('没能拉起分享')
  } catch {
    showToast('分享失败')
  }
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
        <!-- 工具页可用 teleport 往这里放自己的标题栏按钮（如筛选） -->
        <span id="shell-nav-actions" class="shell__slot" />
        <component
          :is="cameraOn ? KeyboardIcon : CameraIcon"
          v-if="hasCamera"
          :class="['shell__star', 'shell__cam']"
          role="button"
          :aria-label="cameraOn ? '切回查询' : '拍照识别'"
          @click.stop="toggleCamera"
        />
        <!-- 小程序风格胶囊：左「…」唤起系统分享，右收藏 -->
        <div class="shell__capsule">
          <button type="button" class="shell__capsule-btn" aria-label="分享" @click.stop="shareSheet = true">
            <van-icon name="ellipsis" />
          </button>
          <i class="shell__capsule-divider" />
          <button
            type="button"
            :class="['shell__capsule-btn', { 'shell__star--on': starred }]"
            :aria-label="starred ? '取消收藏' : '收藏'"
            @click.stop="toggleStar"
          >
            <van-icon :name="starred ? 'star' : 'star-o'" />
          </button>
        </div>
      </template>
    </van-nav-bar>
    <van-action-sheet v-model:show="shareSheet" :actions="shareActions" cancel-text="取消" close-on-click-action @select="onSharePick" />
    <pin-tool-sheet v-if="meta" v-model:show="pinSheet" :tool="meta" />
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

  // 工具页挂进来的标题栏按钮容器
  &__slot {
    display: inline-flex;
    align-items: center;
  }

  // 摄像头按钮与胶囊之间留空
  &__cam {
    margin-right: $space-3;
  }

  // vant 给整个右侧区域加了按下变淡，去掉，改由胶囊内各按钮自己反馈
  &__nav :deep(.van-nav-bar__right:active) {
    opacity: 1;
  }

  // 右侧胶囊按钮组
  &__capsule {
    display: inline-flex;
    align-items: center;
    height: 30px;
    margin-left: $space-2;
    border: 1px solid var(--c-border, rgba(127, 127, 127, 0.35));
    border-radius: 15px;
  }

  // 胶囊内单个按钮
  &__capsule-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 100%;
    padding: 0;
    font-size: 20px;
    color: var(--c-text);
    background: none;
    border: 0;

    &:active {
      opacity: 0.5;
    }

    &.shell__star--on {
      color: var(--c-primary);
    }
  }

  // 胶囊中间分隔线
  &__capsule-divider {
    width: 1px;
    height: 16px;
    background: var(--c-border, rgba(127, 127, 127, 0.35));
  }

  &__body {
    max-width: 720px;
    margin: 0 auto;
    padding: var(--page-pad);
    padding-bottom: calc(var(--page-pad) + var(--safe-bottom));
  }
}
</style>
