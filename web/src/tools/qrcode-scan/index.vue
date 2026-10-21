<script setup lang="ts">
// 二维码识别：App 内用原生取景扫码或识别相册图，显示码种与内容，可复制；网址确认后才打开
import BottomActions from '@/shared/BottomActions.vue'
import { ref } from 'vue'
import { showConfirmDialog, showFailToast, showSuccessToast } from 'vant'
import { isNativeAvailable } from '@/native/bridge'
import { decodeQrImage, scanQr, type QrResult } from '@/native/qrcode'
import { clipboardWrite, openIntent, openSettings } from '@/native/system'
import { EDIT_BASIC, pickImages } from '@/shared/image-io'
import { displayText, formatLabel, isOpenableUrl, mergeResults } from './logic'

/** 无宿主时的提示 */
const TIP_NO_HOST = '扫码与识图需要在 App 内使用，浏览器里没有原生相机与解码通道。'
/** 相机权限被拒的提示 */
const TIP_DENIED = '没有相机权限，无法扫码。请在系统设置里允许「相机」后重试。'
/** 没识别到码的提示 */
const TIP_EMPTY = '没有识别到二维码或条码，换张更清晰的图试试。'

/** 是否在容器内 */
const hosted = isNativeAvailable()
/** 当前忙：扫码页开着或正在识图 */
const busy = ref(false)
/** 相机权限被拒 */
const denied = ref(false)
/** 识别结果列表，新结果排在最前 */
const results = ref<QrResult[]>([])

/** 把一批新结果并进列表（去重，新的在前） */
function addResults(batch: QrResult[]): void {
  results.value = mergeResults(batch, results.value)
}

/** 取错误对象里的提示文字 */
function messageOf(e: unknown, fallback: string): string {
  return (e as { message?: string }).message || fallback
}

/** 打开取景扫码页 */
async function onScan(): Promise<void> {
  if (busy.value) return
  busy.value = true
  denied.value = false
  try {
    const r = await scanQr()
    if (!r.cancelled) addResults(r.results)
  } catch (e) {
    if ((e as { code?: string }).code === 'PERMISSION_DENIED') denied.value = true
    else showFailToast(messageOf(e, '扫码失败'))
  } finally {
    busy.value = false
  }
}

/** 选一张相册图并识别 */
async function onPickImage(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    const [img] = await pickImages({ edit: EDIT_BASIC, multiple: false })
    if (!img?.path) return
    const found = await decodeQrImage(img.path)
    if (found.length === 0) showFailToast(TIP_EMPTY)
    else addResults(found)
  } catch (e) {
    showFailToast(messageOf(e, '识别失败'))
  } finally {
    busy.value = false
  }
}

/** 复制一条结果的文本 */
async function onCopy(r: QrResult): Promise<void> {
  const ok = await clipboardWrite(r.text)
  if (ok) showSuccessToast('已复制')
  else showFailToast('复制失败，请手动长按选择')
}

/** 确认后用系统浏览器打开网址 */
async function onOpenUrl(r: QrResult): Promise<void> {
  try {
    await showConfirmDialog({ title: '打开网址', message: r.text, confirmButtonText: '打开' })
  } catch {
    return
  }
  try {
    if (!(await openIntent('url', r.text.trim()))) showFailToast('没有能打开的应用')
  } catch (e) {
    showFailToast(messageOf(e, '打不开'))
  }
}

/** 去系统设置里开相机权限 */
async function onOpenSettings(): Promise<void> {
  try {
    await openSettings('app')
  } catch (e) {
    showFailToast(messageOf(e, '打不开系统设置'))
  }
}

/** 清空结果 */
function onClear(): void {
  results.value = []
}
</script>

<template>
  <div class="tool-page">
    <van-notice-bar v-if="!hosted" wrapable :scrollable="false" left-icon="info-o">{{ TIP_NO_HOST }}</van-notice-bar>

    <tool-group>
      <div v-if="denied" class="qs-denied">
        <p>{{ TIP_DENIED }}</p>
        <van-button size="small" plain round @click="onOpenSettings">打开系统设置</van-button>
      </div>
      <p class="tool-hint">支持二维码与常见条码；一张图里有多个码时会全部列出。</p>
    </tool-group>

    <tool-group v-if="results.length">
      <div class="qs-head">
        <span class="tool-group__title">识别结果（{{ results.length }}）</span>
        <van-button size="mini" plain round @click="onClear">清空</van-button>
      </div>
      <div v-for="(r, i) in results" :key="`${r.format}-${i}-${r.bytes}`" class="qs-item">
        <div class="qs-item__format">{{ formatLabel(r.format) }}</div>
        <div class="qs-item__text">{{ displayText(r) }}</div>
        <div class="qs-item__ops">
          <van-button size="small" plain round :disabled="r.text === ''" @click="onCopy(r)">复制</van-button>
          <van-button v-if="isOpenableUrl(r.text)" size="small" type="primary" plain round @click="onOpenUrl(r)">打开网址</van-button>
        </div>
      </div>
    </tool-group>

    <!-- 底部动作栏：左边相册识图，右边主按钮扫码（取景扫码是原生页，不走拍照项） -->
    <bottom-actions :main-loading="busy" album main main-text="扫码" :disabled="{ album: !hosted || busy, main: !hosted || busy }" @album="onPickImage" @main="onScan" />
  </div>
</template>

<style lang="scss" scoped>
/* 权限被拒的提示 */
.qs-denied {
  margin-top: $space-3;
  font-size: 13px;
  color: var(--c-error);
}

/* 结果标题行 */
.qs-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

/* 单条结果之间的分隔 */
.qs-item {
  padding: $space-3 0;
  border-top: 1px solid var(--c-border);

  &:first-of-type {
    border-top: 0;
  }
}

/* 码种标签 */
.qs-item__format {
  font-size: 12px;
  color: var(--c-text-muted);
}

/* 识别内容，长文本与网址自动换行 */
.qs-item__text {
  margin: $space-1 0 $space-2;
  font-size: 15px;
  color: var(--c-text);
  word-break: break-all;
  white-space: pre-wrap;
  user-select: text;
}

/* 操作按钮并排 */
.qs-item__ops {
  display: flex;
  gap: $space-2;
}
</style>
