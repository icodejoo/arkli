<script setup lang="ts">
// 设置页（底栏根 tab 之一，不显示返回箭头）：目前只有“缓存”卡片（占用 + 清理）
import { onMounted } from 'vue'
import { showConfirmDialog, showToast } from 'vant'
import { isNativeAvailable } from '@/native/bridge'
import { clearCache, getCacheStats } from '@/native/cache'
import { CACHE_ONLY_APP, useCacheCard } from './settingsCache'

/** 是否有原生宿主 */
const native = isNativeAvailable()
/** 缓存卡片状态 */
const { text, busy, refresh, clean } = useCacheCard({
  getStats: () => getCacheStats(),
  clear: () => clearCache(),
  confirm: () => showConfirmDialog({ title: '清理缓存', message: '将删除临时文件（正在使用的会保留），确定吗？' }),
  toast: (m) => showToast(m),
})

onMounted(() => {
  if (native) void refresh()
})
</script>

<template>
  <div class="settings">
    <van-nav-bar title="设置" fixed placeholder safe-area-inset-top />
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
    padding-bottom: calc(#{$space-4} + var(--tabbar-total));
  }
}
</style>
