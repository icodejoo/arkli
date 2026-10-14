<script setup lang="ts">
// 应用管理：列出可启动应用，查看版本与安装信息，打开、跳应用详情（卸载入口）、导出安装包
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { showFailToast, showLoadingToast, showToast, closeToast } from 'vant'
import { appFileUrl, appIcon, exportApk, listApps, openApp, openAppSettings, type AppInfo } from '@/native/apps'
import { isNativeAvailable } from '@/native/bridge'
import { share } from '@/native/system'
import { createIconLoader, filterApps, formatBytes, formatDateTime, SORT_OPTIONS, sortApps, summarize, type SortKey } from './logic'

/** 安装包的 mime，分享用 */
const MIME_APK = 'application/vnd.android.package-archive'
/** 登记的行数超过列表长度两倍再多出这么多，就清理一次 */
const PRUNE_SLACK = 50
/** 图标请求的像素边长 */
const ICON_SIZE = 96
/** 无宿主时的提示 */
const TIP_NO_HOST = '应用管理只能在 Arkli 应用里使用。'
/** 只列出可启动应用的说明 */
const TIP_SCOPE = '只显示桌面上有图标的应用，没有桌面入口的后台应用看不到。'

/** 是否在容器内 */
const hosted = isNativeAvailable()
/** 全部应用（含系统，筛选在前端做） */
const all = ref<AppInfo[]>([])
/** 加载中 */
const loading = ref(false)
/** 搜索词 */
const query = ref('')
/** 排序方式 */
const sortKey = ref<SortKey>('name')
/** 是否显示系统应用 */
const showSystem = ref(false)
/** 详情弹窗里的应用 */
const current = ref<AppInfo | null>(null)
/** 详情弹窗是否打开 */
const detailOpen = ref(false)
/** 图标 URL：包名 -> URL；null 表示取失败 */
const icons = reactive<Record<string, string | null>>({})
/** 导出中的取消控制 */
let exportAbort: AbortController | null = null

/** 图标加载器：同包去重，并发 3 */
const loader = createIconLoader((pkg) => appIcon(pkg, ICON_SIZE).then(appFileUrl))
/** 进入视口才请求图标 */
let observer: IntersectionObserver | null = null
/** 正在观察的元素 -> 包名，卸载时清理 */
const watched = new Map<Element, string>()

/** 过滤并排序后的列表 */
const shown = computed(() => sortApps(filterApps(all.value, query.value, showSystem.value), sortKey.value))
/** 列表摘要 */
const summary = computed(() => summarize(shown.value))

/** 拉取应用列表 */
async function load(): Promise<void> {
  if (!hosted) return
  loading.value = true
  try {
    all.value = await listApps(true)
  } catch (e) {
    showFailToast((e as { message?: string }).message || '读取应用列表失败')
  } finally {
    loading.value = false
  }
}

/** 请求某包的图标（已有结果就跳过） */
function requestIcon(pkg: string): void {
  if (pkg in icons) return
  icons[pkg] = null
  void loader.get(pkg).then((url) => {
    icons[pkg] = url
  })
}

/** 行元素挂载 / 卸载时登记到视口观察；函数式 ref，每次渲染都会调用 */
function watchRow(el: unknown, pkg: string): void {
  if (!(el instanceof Element)) return
  if (watched.get(el) === pkg) return
  // 过滤 / 排序后旧行会脱离页面，积累多了就清一遍，免得观察器一直抓着
  if (watched.size > shown.value.length * 2 + PRUNE_SLACK) prune()
  watched.set(el, pkg)
  if (observer) observer.observe(el)
  else requestIcon(pkg)
}

/** 清掉已脱离页面的行 */
function prune(): void {
  for (const el of Array.from(watched.keys())) {
    if (el.isConnected) continue
    observer?.unobserve(el)
    watched.delete(el)
  }
}

/** 打开详情 */
function showDetail(a: AppInfo): void {
  current.value = a
  detailOpen.value = true
}

/** 打开应用 */
async function onOpen(): Promise<void> {
  if (!current.value) return
  try {
    if (!(await openApp(current.value.pkg))) showToast('这个应用没有可打开的入口')
  } catch (e) {
    showFailToast((e as { message?: string }).message || '打开失败')
  }
}

/** 打开系统的应用详情页，用户可在那里卸载 */
async function onSettings(): Promise<void> {
  if (!current.value) return
  try {
    if (!(await openAppSettings(current.value.pkg))) showToast('没能打开应用设置')
  } catch (e) {
    showFailToast((e as { message?: string }).message || '打开失败')
  }
}

/** 导出安装包后交给系统分享 */
async function onExport(): Promise<void> {
  const a = current.value
  if (!a || exportAbort) return
  exportAbort = new AbortController()
  showLoadingToast({ message: '正在导出安装包…', forbidClick: true, duration: 0 })
  try {
    const r = await exportApk(a.pkg, exportAbort.signal)
    closeToast()
    if (!(await share({ path: r.path, mime: MIME_APK, title: r.name }))) showToast('已导出，但没能打开分享面板')
  } catch (e) {
    closeToast()
    const err = e as { code?: string; message?: string }
    if (err.code !== 'CANCELLED') showFailToast(err.message || '导出失败')
  } finally {
    exportAbort = null
  }
}

onMounted(() => {
  if (typeof IntersectionObserver !== 'undefined') {
    observer = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue
          const pkg = watched.get(en.target)
          if (pkg) requestIcon(pkg)
          observer?.unobserve(en.target)
        }
      },
      { rootMargin: '120px' },
    )
    // 观察器创建前已挂载的行补登记
    for (const el of watched.keys()) observer.observe(el)
  }
  void load()
})
onBeforeUnmount(() => {
  observer?.disconnect()
  watched.clear()
  exportAbort?.abort()
})
</script>

<template>
  <div class="tool-page">
    <van-notice-bar v-if="!hosted" wrap-able :scrollable="false" left-icon="info-o">{{ TIP_NO_HOST }}</van-notice-bar>

    <div class="tool-card">
      <van-search v-model="query" placeholder="搜索应用名或包名" shape="round" :disabled="!hosted" />
      <div class="am-bar">
        <van-button v-for="o in SORT_OPTIONS" :key="o.key" size="small" round :type="sortKey === o.key ? 'primary' : 'default'" @click="sortKey = o.key">
          {{ o.name }}
        </van-button>
        <label class="am-sys">
          <span>系统应用</span>
          <van-switch v-model="showSystem" size="20" />
        </label>
      </div>
    </div>

    <van-loading v-if="loading" class="am-loading" vertical>读取中…</van-loading>
    <template v-else-if="hosted">
      <p class="tool-hint am-summary">{{ summary }}</p>
      <van-empty v-if="shown.length === 0" description="没有符合条件的应用" />
      <van-cell-group v-else class="tool-group" :border="false">
        <van-cell
          v-for="a in shown"
          :key="a.pkg"
          :ref="(el: unknown) => watchRow((el as { $el?: Element } | null)?.$el, a.pkg)"
          :title="a.label"
          :label="`${a.versionName || '—'} · ${formatBytes(a.apkBytes)}`"
          is-link
          center
          @click="showDetail(a)"
        >
          <template #icon>
            <img v-if="icons[a.pkg]" class="am-icon" :src="icons[a.pkg]!" alt="" width="40" height="40" />
            <span v-else class="am-icon am-icon--ph">{{ a.label.slice(0, 1) }}</span>
          </template>
        </van-cell>
      </van-cell-group>
      <p class="tool-hint">{{ TIP_SCOPE }}</p>
    </template>

    <van-popup v-model:show="detailOpen" position="bottom" round closeable :style="{ maxHeight: '80%' }">
      <div v-if="current" class="am-detail">
        <div class="am-head">
          <img v-if="icons[current.pkg]" class="am-icon am-icon--big" :src="icons[current.pkg]!" alt="" width="56" height="56" />
          <span v-else class="am-icon am-icon--big am-icon--ph">{{ current.label.slice(0, 1) }}</span>
          <div>
            <div class="am-name">{{ current.label }}</div>
            <van-tag v-if="current.isSystem" plain type="warning">系统应用</van-tag>
          </div>
        </div>
        <van-cell-group :border="false">
          <van-cell title="版本" :value="`${current.versionName || '—'}（${current.versionCode}）`" />
          <van-cell title="包名" :value="current.pkg" />
          <van-cell title="安装包大小" :value="formatBytes(current.apkBytes)" />
          <van-cell title="首次安装" :value="formatDateTime(current.firstInstallMs)" />
          <van-cell title="最近更新" :value="formatDateTime(current.lastUpdateMs)" />
        </van-cell-group>
        <div class="am-buttons">
          <van-button type="primary" round @click="onOpen">打开</van-button>
          <van-button plain round @click="onSettings">应用设置 / 卸载</van-button>
          <van-button plain round @click="onExport">导出安装包</van-button>
        </div>
        <p class="tool-hint">卸载要在系统的应用设置页里操作，这里不会直接卸载。分包安装的应用只导出主安装包。</p>
      </div>
    </van-popup>
  </div>
</template>

<style lang="scss" scoped>
/* 排序与系统开关一行 */
.am-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: $space-2;
  margin-top: $space-2;
}

/* 系统应用开关靠右 */
.am-sys {
  display: flex;
  align-items: center;
  gap: $space-2;
  margin-left: auto;
  font-size: 13px;
  color: var(--c-text-muted);
}

/* 读取中居中 */
.am-loading {
  padding: $space-5 0;
  text-align: center;
}

/* 摘要文字紧贴列表 */
.am-summary {
  margin: 0;
}

/* 应用图标 */
.am-icon {
  flex: 0 0 auto;
  width: 40px;
  height: 40px;
  margin-right: $space-3;
  border-radius: 10px;
  object-fit: cover;

  /* 图标还没取到时的首字占位 */
  &--ph {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--c-surface-active);
    color: var(--c-text-muted);
    font-size: 18px;
    font-weight: 600;
  }

  /* 详情里的大图标 */
  &--big {
    width: 56px;
    height: 56px;
    border-radius: 14px;
    font-size: 24px;
  }
}

/* 详情弹窗内边距 */
.am-detail {
  padding: $space-5 $space-4 $space-4;
}

/* 详情头部：图标 + 名称 */
.am-head {
  display: flex;
  align-items: center;
  margin-bottom: $space-3;
}

/* 应用名 */
.am-name {
  margin-bottom: 4px;
  font-size: 18px;
  font-weight: 600;
  color: var(--c-text);
}

/* 底部操作按钮纵向排开 */
.am-buttons {
  display: flex;
  flex-direction: column;
  gap: $space-2;
  margin-top: $space-4;
}
</style>
