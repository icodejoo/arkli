<script setup lang="ts">
// 设置页：目前只有“缓存”卡片（占用 + 清理）；返回键由路由历史与 backStack（确认框）处理
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { showConfirmDialog, showToast } from 'vant'
import { isNativeAvailable } from '@/native/bridge'
import { clearCache, getCacheStats } from '@/native/cache'
import { CACHE_ONLY_APP, useCacheCard } from './settingsCache'

/** 路由器 */
const router = useRouter()
/** 是否有原生宿主 */
const native = isNativeAvailable()
/** 缓存卡片状态 */
const { text, busy, refresh, clean } = useCacheCard({
  getStats: () => getCacheStats(),
  clear: () => clearCache(),
  confirm: () => showConfirmDialog({ title: '清理缓存', message: '将删除临时文件（正在使用的会保留），确定吗？' }),
  toast: (m) => showToast(m),
})

/** 返回上一页；没有历史时回首页 */
function goBack(): void {
  if (window.history.length > 1) router.back()
  else router.replace('/')
}

onMounted(() => {
  if (native) void refresh()
})
</script>

<template>
  <div class="settings">
    <van-nav-bar title="设置" left-arrow fixed placeholder safe-area-inset-top @click-left="goBack" />
    <main class="settings__body">
      <div class="tool-card">
        <h3 class="tool-card__title">缓存</h3>
        <p v-if="!native" class="tool-hint">{{ CACHE_ONLY_APP }}</p>
        <template v-else>
          <p class="tool-hint">{{ text }}</p>
          <van-button block plain round :loading="busy" @click="clean">清理缓存</van-button>
        </template>
      </div>
    </main>
  </div>
</template>

<style lang="scss" scoped>
.settings {
  min-height: 100vh;

  &__body {
    max-width: 720px;
    margin: 0 auto;
    padding: $space-4;
    padding-bottom: calc(#{$space-4} + var(--safe-bottom));
  }
}
</style>
