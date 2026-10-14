<script setup lang="ts">
// 设备信息：浏览器侧能拿到的屏幕、系统、硬件、网络与特性；在 App 内再补上原生的品牌型号、电池、存储、传感器等，可一键复制
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { showToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import { isNativeAvailable } from '@/native/bridge'
import { deviceDisplay, deviceInfo, deviceStatus, type DeviceInfo } from '@/native/system'
import { buildStaticGroups, buildStatusGroups, collectDeviceInfo, groupsToText, probeFeatures, type DeviceEnv, type InfoGroup } from './logic'

/** 自动刷新间隔（毫秒） */
const AUTO_REFRESH_MS = 3000

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

/** 浏览器侧信息分组 */
const webGroups = ref<InfoGroup[]>([])
/** 原生静态分组（系统、屏幕、传感器、特性） */
const nativeStatic = ref<InfoGroup[]>([])
/** 原生动态分组（电池、内存、存储、网络） */
const nativeLive = ref<InfoGroup[]>([])
/** 是否在 App 内 */
const hasHost = isNativeAvailable()
/** 原生静态信息，动态分组要用到总内存 */
let nativeInfo: DeviceInfo | null = null
/** 3 秒自动刷新开关 */
const auto = ref(false)
/** 正在拉取动态状态（防止重叠请求） */
const loading = ref(false)
/** 自动刷新定时器 */
let timer: ReturnType<typeof setInterval> | undefined
/** 全部分组：原生在前，浏览器在后 */
const groups = computed(() => [...nativeStatic.value, ...nativeLive.value, ...webGroups.value])
/** 全部信息的纯文本 */
const allText = computed(() => groupsToText(groups.value))

/** 重新采集浏览器侧信息（视口、在线状态等会变） */
function refresh(): void {
  webGroups.value = collectDeviceInfo(buildEnv())
}

/** 拉原生动态状态（电池、存储、网络）；失败保留上次结果 */
async function refreshLive(): Promise<void> {
  if (!hasHost || loading.value) return
  loading.value = true
  try {
    const s = await deviceStatus()
    if (s) nativeLive.value = buildStatusGroups(s, nativeInfo?.totalMemBytes ?? null)
  } catch {
    // 偶发失败不打扰，下一次再取
  } finally {
    loading.value = false
  }
}

/** 拉原生静态信息与屏幕参数，只在进页面时一次 */
async function loadNative(): Promise<void> {
  try {
    const [info, display] = await Promise.all([deviceInfo(), deviceDisplay()])
    if (info) {
      nativeInfo = info
      nativeStatic.value = buildStaticGroups(info, display)
    }
  } catch {
    showToast('读取原生信息失败')
  }
  await refreshLive()
}

/** 自动刷新开关：开启起定时器，关闭或卸载时清掉 */
function stopAuto(): void {
  clearInterval(timer)
  timer = undefined
}
watch(auto, (on) => {
  stopAuto()
  if (on) timer = setInterval(() => void refreshLive(), AUTO_REFRESH_MS)
})

/** 复制全部信息 */
async function copyAll(): Promise<void> {
  showToast((await copyText(allText.value)) ? '已复制' : '复制失败，请手动长按选择')
}

onMounted(() => {
  refresh()
  void loadNative()
  window.addEventListener('resize', refresh)
  window.addEventListener('online', refresh)
  window.addEventListener('offline', refresh)
})
onUnmounted(() => {
  stopAuto()
  window.removeEventListener('resize', refresh)
  window.removeEventListener('online', refresh)
  window.removeEventListener('offline', refresh)
})
</script>

<template>
  <div class="tool-page">
    <div v-if="hasHost" class="tool-card di-live">
      <van-button size="small" plain :loading="loading" @click="refreshLive">刷新电池 / 存储 / 网络</van-button>
      <van-cell title="每 3 秒自动刷新" center class="di-auto">
        <template #right-icon><van-switch v-model="auto" size="20" /></template>
      </van-cell>
    </div>
    <van-cell-group v-for="g in groups" :key="g.title" :title="g.title" class="tool-group">
      <van-cell v-for="(i, idx) in g.items" :key="`${idx}-${i.label}`" :title="i.label" :value="i.value" class="di-cell" />
    </van-cell-group>
    <van-button type="primary" block round @click="copyAll">复制全部</van-button>
    <p v-if="hasHost" class="tool-hint">带「原生」字样的分组来自系统接口，取不到的项显示「—」。</p>
    <p v-else class="tool-hint">这里只列页面自己能读到的信息。在 App 内可看到更多（品牌型号、电池、存储、传感器等）。</p>
  </div>
</template>

<style lang="scss" scoped>
/* 刷新条：按钮与自动刷新开关纵向排开 */
.di-live {
  display: flex;
  flex-direction: column;
  gap: $space-2;
}

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
