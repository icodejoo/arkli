<script setup lang="ts">
// 文件夹清理：授权一个文件夹，扫描大文件 / 空文件 / 安装包，勾选后删除（不经回收站，无法恢复）
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { showConfirmDialog, showFailToast, showSuccessToast, showToast } from 'vant'
import { isNativeAvailable } from '@/native/bridge'
import { deleteDirItems, forgetDir, listDirs, pickDir, scanDir, type DirFolder, type DirItem, type DirScanMode } from '@/native/dir'
import {
  allSelected, applyDeleteResult, chunkIds, DEFAULT_THRESHOLD_MB, deleteSummary, formatBytes, MODE_OPTIONS, mergeDeleteResults, scanSummary,
  selectedTotals, SORT_OPTIONS, sortItems, THRESHOLD_OPTIONS_MB, thresholdBytes, thresholdLabel, toggleAll, toggleSelect, type SortKey,
} from './logic'

/** 无宿主时的提示 */
const TIP_NO_HOST = '文件夹清理需要在 App 内使用。'
/** 删除的警示语 */
const TIP_DANGER = '删除后无法恢复，不会进回收站。请先看清再勾选。'
/** 列表一次渲染的条数，更多的点「再显示」 */
const PAGE_SIZE = 200
/** 时间格式补零用 */
const PAD = 2

/** 是否在容器内 */
const hosted = isNativeAvailable()
/** 已授权的文件夹 */
const folders = ref<DirFolder[]>([])
/** 当前选中的文件夹令牌 */
const token = ref<string | null>(null)
/** 扫描模式 */
const mode = ref<Exclude<DirScanMode, 'all'>>('large')
/** 大文件阈值（MB） */
const thresholdMb = ref<number>(DEFAULT_THRESHOLD_MB)
/** 是否正在扫描 */
const scanning = ref(false)
/** 扫描进度：已遍历节点数 */
const progress = ref(0)
/** 是否正在删除 */
const deleting = ref(false)
/** 扫描结果 */
const items = ref<DirItem[]>([])
/** 是否已扫描过（用来区分「还没扫」与「没找到」） */
const scanned = ref(false)
/** 结果摘要 */
const summary = ref('')
/** 勾选的项 */
const selected = ref<Set<string>>(new Set())
/** 排序方式 */
const sortKey = ref<SortKey>('size')
/** 已显示的条数上限 */
const shownCount = ref(PAGE_SIZE)
/** 当前扫描或删除的取消控制 */
let abort: AbortController | null = null

/** 排好序的全部结果 */
const sorted = computed(() => sortItems(items.value, sortKey.value))
/** 当前渲染的前若干条 */
const visible = computed(() => sorted.value.slice(0, shownCount.value))
/** 已选合计 */
const totals = computed(() => selectedTotals(items.value, selected.value))
/** 是否全选 */
const isAll = computed(() => allSelected(items.value, selected.value))
/** 当前选中的文件夹名 */
const currentName = computed(() => folders.value.find((f) => f.token === token.value)?.name ?? '')
/** 忙碌中（扫描或删除） */
const busy = computed(() => scanning.value || deleting.value)

/** 取错误文字 */
function msgOf(e: unknown, fallback: string): string {
  return (e as { message?: string }).message || fallback
}

/** 是否是用户取消 */
function isCancelled(e: unknown): boolean {
  return (e as { code?: string }).code === 'CANCELLED'
}

/** 毫秒时间戳转 `yyyy-mm-dd`，未知返回「—」 */
function dateOf(ms: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(PAD, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 读取已授权的文件夹列表 */
async function loadFolders(): Promise<void> {
  if (!hosted) return
  try {
    folders.value = await listDirs()
    if (!folders.value.some((f) => f.token === token.value)) token.value = folders.value[0]?.token ?? null
  } catch (e) {
    showFailToast(msgOf(e, '读取文件夹列表失败'))
  }
}

/** 弹系统选择器授权一个新文件夹 */
async function onPick(): Promise<void> {
  try {
    const dir = await pickDir()
    if (!dir) return
    await loadFolders()
    selectFolder(dir.token)
  } catch (e) {
    showFailToast(msgOf(e, '选择文件夹失败'))
  }
}

/** 切换当前文件夹，旧结果作废 */
function selectFolder(t: string): void {
  if (busy.value || token.value === t) return
  token.value = t
  resetResult()
}

/** 清空扫描结果 */
function resetResult(): void {
  items.value = []
  selected.value = new Set()
  scanned.value = false
  summary.value = ''
  shownCount.value = PAGE_SIZE
}

/** 移除一个文件夹的授权（不动里面的文件） */
async function onForget(f: DirFolder): Promise<void> {
  if (busy.value) return
  try {
    await showConfirmDialog({ title: '移除授权', message: `不再允许本应用访问「${f.name}」。文件夹里的内容不受影响。` })
  } catch {
    return
  }
  try {
    await forgetDir(f.token)
    if (token.value === f.token) {
      token.value = null
      resetResult()
    }
    await loadFolders()
  } catch (e) {
    showFailToast(msgOf(e, '移除失败'))
  }
}

/** 开始扫描 */
async function onScan(): Promise<void> {
  if (!token.value || busy.value) return
  resetResult()
  scanning.value = true
  progress.value = 0
  abort = new AbortController()
  try {
    const opts = mode.value === 'large' ? { mode: mode.value, minBytes: thresholdBytes(thresholdMb.value) } : { mode: mode.value }
    const r = await scanDir(token.value, opts, { signal: abort.signal, onProgress: (n) => (progress.value = n) })
    items.value = r.items
    scanned.value = true
    summary.value = scanSummary(r.items, r.scanned, r.truncated)
    sortKey.value = mode.value === 'large' || mode.value === 'apk' ? 'size' : 'path'
  } catch (e) {
    if (!isCancelled(e)) showFailToast(msgOf(e, '扫描失败'))
  } finally {
    scanning.value = false
    abort = null
  }
}

/** 取消当前扫描或删除 */
function onCancel(): void {
  abort?.abort()
}

/** 全选 / 取消全选 */
function onToggleAll(): void {
  selected.value = toggleAll(items.value, selected.value)
}

/** 勾选一项 */
function onToggle(id: string): void {
  selected.value = toggleSelect(selected.value, id)
}

/** 二次确认后删除已选项 */
async function onDelete(): Promise<void> {
  if (!token.value || busy.value || totals.value.count === 0) return
  try {
    await showConfirmDialog({
      title: '确认删除？',
      message: `将删除 ${totals.value.count} 项，约 ${formatBytes(totals.value.bytes)}。\n删除后无法恢复，不会进回收站。`,
      confirmButtonText: '删除',
      confirmButtonColor: 'var(--c-error)',
    })
  } catch {
    return
  }
  const ids = items.value.filter((i) => selected.value.has(i.id)).map((i) => i.id)
  deleting.value = true
  abort = new AbortController()
  try {
    const parts = []
    for (const batch of chunkIds(ids)) parts.push(await deleteDirItems(token.value, batch, abort.signal))
    const result = mergeDeleteResults(parts)
    const next = applyDeleteResult(items.value, ids, result)
    items.value = next.items
    selected.value = next.selected
    if (result.failed.length > 0) showToast(deleteSummary(result))
    else showSuccessToast(deleteSummary(result))
  } catch (e) {
    if (!isCancelled(e)) showFailToast(msgOf(e, '删除失败'))
    else showToast('已取消，已删除的部分无法恢复，建议重新扫描')
  } finally {
    deleting.value = false
    abort = null
  }
}

onMounted(() => void loadFolders())
onBeforeUnmount(() => abort?.abort())
</script>

<template>
  <div class="tool-page">
    <van-notice-bar v-if="!hosted" wrapable :scrollable="false" left-icon="info-o">{{ TIP_NO_HOST }}</van-notice-bar>

    <template v-else>
      <div class="tool-card">
        <div class="tool-card__title">1. 选择文件夹</div>
        <van-cell-group v-if="folders.length" :border="false">
          <van-cell v-for="f in folders" :key="f.token" :title="f.name || '（未命名）'" center clickable @click="selectFolder(f.token)">
            <template #icon>
              <van-icon :name="f.token === token ? 'checked' : 'circle'" class="fc-dot" :class="{ 'fc-dot--on': f.token === token }" />
            </template>
            <template #right-icon>
              <van-button size="mini" plain :disabled="busy" @click.stop="onForget(f)">移除</van-button>
            </template>
          </van-cell>
        </van-cell-group>
        <van-button block round plain type="primary" class="fc-pick" :disabled="busy" @click="onPick">
          {{ folders.length ? '再授权一个文件夹' : '选择文件夹' }}
        </van-button>
        <p class="tool-hint">只会访问你在系统选择器里选中的文件夹，不需要存储权限。Android 11 起系统不允许选存储根目录和 Download 本身，请选里面的子文件夹。</p>
      </div>

      <div class="tool-card">
        <div class="tool-card__title">2. 选择要找的东西</div>
        <div class="fc-row">
          <van-button v-for="m in MODE_OPTIONS" :key="m.key" size="small" round :type="mode === m.key ? 'primary' : 'default'" :disabled="busy" @click="mode = m.key">
            {{ m.name }}
          </van-button>
        </div>
        <p class="tool-hint">{{ MODE_OPTIONS.find((m) => m.key === mode)?.hint }}</p>
        <template v-if="mode === 'large'">
          <div class="fc-label">大于</div>
          <div class="fc-row">
            <van-button v-for="mb in THRESHOLD_OPTIONS_MB" :key="mb" size="small" round :type="thresholdMb === mb ? 'primary' : 'default'" :disabled="busy" @click="thresholdMb = mb">
              {{ thresholdLabel(mb) }}
            </van-button>
          </div>
        </template>
        <van-button v-if="!scanning" block round type="primary" class="fc-go" :disabled="!token || deleting" @click="onScan">
          {{ token ? `扫描「${currentName}」` : '先选择文件夹' }}
        </van-button>
        <div v-else class="fc-scanning">
          <van-loading size="20">已遍历 {{ progress }} 项…</van-loading>
          <van-button size="small" plain @click="onCancel">取消</van-button>
        </div>
      </div>

      <div v-if="scanned" class="tool-card">
        <div class="tool-card__title">3. 结果</div>
        <p class="tool-hint fc-summary">{{ summary }}</p>
        <van-empty v-if="items.length === 0" description="没有找到符合条件的内容" />
        <template v-else>
          <div class="fc-row">
            <van-button v-for="o in SORT_OPTIONS" :key="o.key" size="small" round :type="sortKey === o.key ? 'primary' : 'default'" @click="sortKey = o.key">
              {{ o.name }}
            </van-button>
            <van-button size="small" plain class="fc-all" :disabled="deleting" @click="onToggleAll">{{ isAll ? '取消全选' : '全选' }}</van-button>
          </div>
          <van-cell-group :border="false" class="fc-list">
            <van-cell v-for="i in visible" :key="i.id" center clickable @click="onToggle(i.id)">
              <template #icon>
                <van-icon :name="selected.has(i.id) ? 'checked' : 'circle'" class="fc-dot" :class="{ 'fc-dot--on': selected.has(i.id) }" />
              </template>
              <template #title>
                <div class="fc-name">{{ i.isDir ? '[文件夹] ' : '' }}{{ i.name }}</div>
              </template>
              <template #label>
                <div class="fc-path">{{ i.relPath }}</div>
                <div class="fc-meta">{{ i.isDir ? '空文件夹' : formatBytes(i.bytes) }} · {{ dateOf(i.lastModifiedMs) }}</div>
              </template>
            </van-cell>
          </van-cell-group>
          <van-button v-if="sorted.length > shownCount" block plain round size="small" @click="shownCount += PAGE_SIZE">
            再显示 {{ Math.min(PAGE_SIZE, sorted.length - shownCount) }} 条（共 {{ sorted.length }} 条，全选针对全部）
          </van-button>
          <p class="tool-hint fc-danger">{{ TIP_DANGER }}</p>
          <div class="fc-bar">
            <div class="fc-bar__text">已选 {{ totals.count }} 项，可释放 {{ formatBytes(totals.bytes) }}</div>
            <van-button v-if="!deleting" type="danger" round size="small" :disabled="totals.count === 0" @click="onDelete">删除所选</van-button>
            <van-button v-else plain round size="small" @click="onCancel">删除中…取消</van-button>
          </div>
        </template>
      </div>
    </template>
  </div>
</template>

<style lang="scss" scoped>
/* 一行按钮，自动换行 */
.fc-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: $space-2;
}

/* 小标题 */
.fc-label {
  margin: $space-3 0 $space-2;
  font-size: 13px;
  color: var(--c-text-muted);
}

/* 选择文件夹按钮 */
.fc-pick {
  margin-top: $space-3;
}

/* 开始扫描 */
.fc-go {
  margin-top: $space-4;
}

/* 扫描中的进度行 */
.fc-scanning {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: $space-4;
}

/* 勾选圆点 */
.fc-dot {
  flex: 0 0 auto;
  margin-right: $space-3;
  font-size: 20px;
  color: var(--c-text-muted);

  /* 已选中 */
  &--on {
    color: var(--c-primary);
  }
}

/* 摘要紧贴列表 */
.fc-summary {
  margin: 0 0 $space-2;
}

/* 全选靠右 */
.fc-all {
  margin-left: auto;
}

/* 结果列表上方留白 */
.fc-list {
  margin: $space-2 0;
}

/* 文件名一行省略 */
.fc-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--c-text);
}

/* 相对路径 */
.fc-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 大小与时间 */
.fc-meta {
  margin-top: 2px;
}

/* 红字警示 */
.fc-danger {
  color: var(--c-error);
}

/* 底部合计与删除按钮，滚动时吸附在屏幕底部 */
.fc-bar {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $space-3;
  margin-top: $space-3;
  padding: $space-3 0;
  background: var(--c-surface);
  border-top: 1px solid var(--c-border);
}

/* 合计文字 */
.fc-bar__text {
  font-size: 14px;
  color: var(--c-text);
}
</style>
