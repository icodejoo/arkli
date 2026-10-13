<script setup lang="ts">
// 根组件：只放路由出口（带过渡），并让 Vant 暗色类跟随系统深浅色
import { onBeforeUnmount, onMounted } from 'vue'

/** Vant 暗色主题的 class 名 */
const DARK_CLASS = 'van-theme-dark'
/** 深色模式媒体查询 */
const DARK_QUERY = '(prefers-color-scheme: dark)'

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

onBeforeUnmount(() => mql?.removeEventListener('change', applyScheme))
</script>

<template>
  <router-view v-slot="{ Component }">
    <transition name="route" mode="out-in">
      <component :is="Component" />
    </transition>
  </router-view>
</template>
