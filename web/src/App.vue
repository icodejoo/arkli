<script setup lang="ts">
// 根组件：路由出口（工具页 iOS 风格推入/弹出，底栏 tab 之间淡入淡出）+ 底部 tab 栏，并让 Vant 暗色类跟随系统深浅色
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useKeyboardOpen } from '@/shared/useKeyboardOpen'
import { holdScroll, isCachedRoute, isTabPath, pageTransition, releaseScroll, type PageTransition } from '@/router/transition'

/** Vant 暗色主题的 class 名 */
const DARK_CLASS = 'van-theme-dark'
/** 深色模式媒体查询 */
const DARK_QUERY = '(prefers-color-scheme: dark)'

/** keep-alive 缓存的视图组件名（与 CACHED_ROUTES 对应） */
const CACHED_VIEWS = ['HomeView', 'AiView', 'FavoritesView', 'SettingsView']

/** 底栏四个 tab：路径、文案、Vant 图标（顺序与 TAB_PATHS 一致） */
const TABS = [
  { to: '/', label: '首页', icon: 'home-o' },
  { to: '/ai', label: 'AI', icon: 'bulb-o' },
  { to: '/favorites', label: '收藏', icon: 'star-o' },
  { to: '/settings', label: '设置', icon: 'setting-o' },
] as const

/** 路由器 */
const router = useRouter()
/** 当前路由 */
const route = useRoute()
/** 软键盘是否弹出：弹出时 WebView 被顶起，底栏要藏起来 */
const keyboardOpen = useKeyboardOpen()
/** 底栏只在四个根 tab 页显示，工具页不显示；键盘弹出时也隐藏 */
const showTabbar = computed(() => isTabPath(route.path) && !keyboardOpen.value)
/** 当前这次切换用的转场：进入更深一层推入，回到更浅一层弹出；在导航开始前定好，Transition 读到的就是它 */
const kind = ref<PageTransition>('push')
/** 这次切换的来源、目标路由名，用来判断哪个页面被缓存 */
let leavingName: unknown
let enteringName: unknown
/** 导航开始时（DOM 还没变）的滚动位置：新页面挂载后文档可能变短，scrollY 会被夹小，所以必须在守卫里先记 */
let leavingScroll = 0
/** 被缓存页面（四个根 tab）上次离开时的滚动位置，按路由名记；回来时还原 */
const cachedScroll: Record<string, number> = {}
/** 本次进入的页面是否正在还原滚动位置，转场结束要真正 scrollTo */
let restoring = 0
const removeGuard = router.beforeEach((to, from) => {
  kind.value = pageTransition(to.path, from.path)
  leavingName = from.name
  enteringName = to.name
  leavingScroll = window.scrollY
})

/** 离开的页面脱离文档流前：被缓存的记下滚动位置，然后让它停在原处 */
function onBeforeLeave(el: Element): void {
  const y = leavingScroll
  if (isCachedRoute(leavingName)) cachedScroll[leavingName as string] = y
  holdScroll(el as HTMLElement, y)
}

/** 离开转场结束：被缓存的页面是同一个节点，清掉内联的 top 等，免得下次进来残留 */
function onAfterLeave(el: Element): void {
  releaseScroll(el as HTMLElement)
}

/** 进入的页面脱离文档流前：回到被缓存的页面时，让它先停在上次离开的位置 */
function onBeforeEnter(el: Element): void {
  restoring = isCachedRoute(enteringName) ? (cachedScroll[enteringName as string] ?? 0) : 0
  holdScroll(el as HTMLElement, restoring)
}

/** 进入转场结束（页面已回到文档流）：同一个任务里清掉内联样式并真正滚过去，不会闪 */
function onAfterEnter(el: Element): void {
  releaseScroll(el as HTMLElement)
  if (restoring > 0) window.scrollTo(0, restoring)
  restoring = 0
}

/** 系统深浅色变化监听器 */
let mql: MediaQueryList | undefined

/** 按系统深浅色切换 html 上的暗色类 */
function applyScheme(): void {
  document.documentElement.classList.toggle(DARK_CLASS, !!mql?.matches)
}

onMounted(() => {
  mql = window.matchMedia(DARK_QUERY)
  applyScheme()
  mql.addEventListener('change', applyScheme)
})

onBeforeUnmount(() => {
  mql?.removeEventListener('change', applyScheme)
  removeGuard()
})
</script>

<template>
  <router-view v-slot="{ Component }">
    <!-- 新旧页面同时在场（不用 out-in），样式见 styles/index.scss 的“页面转场” -->
    <transition
      :name="`page-${kind}`"
      @before-leave="onBeforeLeave"
      @after-leave="onAfterLeave"
      @before-enter="onBeforeEnter"
      @after-enter="onAfterEnter"
    >
      <!-- 四个 tab 页缓存：回来时保留搜索词等状态，滚动位置在上面的钩子里还原；工具页每次重建 -->
      <keep-alive :include="CACHED_VIEWS">
        <component :is="Component" />
      </keep-alive>
    </transition>
  </router-view>
  <!-- 底栏：route 模式按当前路径高亮；tab 之间用 replace，不堆历史，返回键从工具页回到来的那个 tab -->
  <van-tabbar v-if="showTabbar" route replace fixed safe-area-inset-bottom>
    <van-tabbar-item v-for="t in TABS" :key="t.to" :to="t.to" :icon="t.icon">{{ t.label }}</van-tabbar-item>
  </van-tabbar>
</template>
