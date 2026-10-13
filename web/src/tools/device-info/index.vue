<script setup lang="ts">
// 设备信息：展示浏览器侧能拿到的屏幕、系统、硬件、网络与特性，可一键复制
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { showToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import { collectDeviceInfo, groupsToText, probeFeatures, type DeviceEnv, type InfoGroup } from './logic'

/** 读 WebGL 显卡型号，拿不到返回空串 */
function readGpu(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl')
    const ext = gl?.getExtension('WEBGL_debug_renderer_info')
    return gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : ''
  } catch {
    return ''
  }
}

/** 从全局拼出采集用的环境对象 */
function buildEnv(): DeviceEnv {
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: NonNullable<DeviceEnv['nav']>['connection'] }
  let timeZone = ''
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    // Intl 不可用时留空
  }
  return {
    nav,
    screen: window.screen,
    viewport: { innerWidth: window.innerWidth, innerHeight: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
    timeZone,
    matchMedia: (q) => window.matchMedia(q),
    features: probeFeatures(window as unknown as Parameters<typeof probeFeatures>[0]),
    gpu: readGpu(),
  }
}

/** 信息分组 */
const groups = ref<InfoGroup[]>([])
/** 全部信息的纯文本 */
const allText = computed(() => groupsToText(groups.value))

/** 重新采集（视口、在线状态等会变） */
function refresh(): void {
  groups.value = collectDeviceInfo(buildEnv())
}

/** 复制全部信息 */
async function copyAll(): Promise<void> {
  showToast((await copyText(allText.value)) ? '已复制' : '复制失败，请手动长按选择')
}

onMounted(() => {
  refresh()
  window.addEventListener('resize', refresh)
  window.addEventListener('online', refresh)
  window.addEventListener('offline', refresh)
})
onUnmounted(() => {
  window.removeEventListener('resize', refresh)
  window.removeEventListener('online', refresh)
  window.removeEventListener('offline', refresh)
})
</script>

<template>
  <div class="tool-page">
    <van-cell-group v-for="g in groups" :key="g.title" :title="g.title" class="tool-group">
      <van-cell v-for="i in g.items" :key="i.label" :title="i.label" :value="i.value" class="di-cell" />
    </van-cell-group>
    <van-button type="primary" block round @click="copyAll">复制全部</van-button>
    <p class="tool-hint">这里只列页面自己能读到的信息。电池、存储、品牌型号等需要原生能力，之后会补上。</p>
  </div>
</template>

<style lang="scss" scoped>
/* 值可能很长（UA），允许换行并强制断词；标题限宽避免挤压值 */
.di-cell {
  :deep(.van-cell__title) {
    flex: 0 0 42%;
  }

  :deep(.van-cell__value) {
    flex: 1;
    word-break: break-all;
    color: var(--c-text);
  }
}
</style>
