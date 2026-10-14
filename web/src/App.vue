<script setup lang="ts">
// 根组件：只放路由出口（iOS 风格的推入/弹出转场），并让 Vant 暗色类跟随系统深浅色
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { holdScroll, isCachedRoute, pageTransition, releaseScroll, type PageTransition } from '@/router/transition'

/** Vant 暗色主题的 class 名 */
const DARK_CLASS = 'van-theme-dark'
/** 深色模式媒体查询 */
const DARK_QUERY = '(prefers-color-scheme: dark)'

/** 路由器 */
const router = useRouter()
/** 当前这次切换用的转场：进入更深一层推入，回到更浅一层弹出；在导航开始前定好，Transition 读到的就是它 */
const kind = ref<PageTransition>('push')
/** 这次切换的来源、目标路由名，用来判断哪个页面被缓存 */
let leavingName: unknown
let enteringName: unknown
/** 被缓存页面（首页）上次离开时的滚动位置；回来时还原 */
let cachedScroll = 0
/** 本次进入的页面是否正在还原滚动位置，转场结束要真正 scrollTo */
let restoring = 0
const removeGuard = router.beforeEach((to, from) => {
  kind.value = pageTransition(to.path, from.path)
  leavingName = from.name
  enteringName = to.name
})

/** 离开的页面脱离文档流前：被缓存的记下滚动位置，然后让它停在原处 */
function onBeforeLeave(el: Element): void {
  const y = window.scrollY
  if (isCachedRoute(leavingName)) cachedScroll = y
  holdScroll(el as HTMLElement, y)
}

/** 离开转场结束：被缓存的页面是同一个节点，清掉内联的 top 等，免得下次进来残留 */
function onAfterLeave(el: Element): void {
  releaseScroll(el as HTMLElement)
}

/** 进入的页面脱离文档流前：回到被缓存的页面时，让它先停在上次离开的位置 */
function onBeforeEnter(el: Element): void {
  restoring = isCachedRoute(enteringName) ? cachedScroll : 0
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
      <!-- 首页缓存：回来时保留搜索词等状态，滚动位置在上面的钩子里还原；工具页每次重建 -->
      <keep-alive include="HomeView">
        <component :is="Component" />
      </keep-alive>
    </transition>
  </router-view>
</template>
