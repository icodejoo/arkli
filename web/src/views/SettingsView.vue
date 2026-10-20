<script setup lang="ts">
// 设置页（底栏根 tab 之一，不显示返回箭头）：按分组 + van-cell 组织——“样式”（主题）与“存储”（缓存占用 + 清理）
import { onMounted } from 'vue'
import { showConfirmDialog, showToast } from 'vant'
import { isNativeAvailable } from '@/native/bridge'
import { clearCache, getCacheStats } from '@/native/cache'
import CellPicker from '@/shared/CellPicker.vue'
import type { CellOption } from '@/shared/cellPicker'
import { setThemeMode, themeMode, THEME_MODES, type ThemeMode } from '@/shared/theme'
import { CACHE_ONLY_APP, useCacheCard } from './settingsCache'

/** 主题可选项：取值与文案 */
const THEME_OPTIONS: readonly CellOption[] = [
  { value: THEME_MODES.LIGHT, label: '亮色' },
  { value: THEME_MODES.DARK, label: '暗色' },
  { value: THEME_MODES.SYSTEM, label: '跟随系统' },
]

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
      <tool-group title="样式">
        <cell-picker :model-value="themeMode" title="主题" :options="THEME_OPTIONS" @update:model-value="setThemeMode($event as ThemeMode)" />
      </tool-group>
      <tool-group title="存储">
        <van-cell v-if="!native" title="清理缓存" :label="CACHE_ONLY_APP" center class="is-disabled" />
        <van-cell v-else title="清理缓存" :label="text" :value="busy ? '清理中' : ''" is-link center :clickable="!busy" @click="!busy && clean()" />
      </tool-group>
    </main>
  </div>
</template>

<style lang="scss" scoped>
.settings {
  min-height: 100vh;

  &__body {
    max-width: 720px;
    margin: 0 auto;
    padding: var(--page-pad);
    padding-bottom: calc(var(--page-pad) + var(--tabbar-total));
  }
}

/* 无宿主时缓存项置灰 */
.is-disabled {
  opacity: 0.5;
}
</style>
