<script setup lang="ts">
// WiFi 二维码：输入名称与密码，生成可扫码连接的二维码（系统不允许读取已保存密码）
import BottomActions from '@/shared/BottomActions.vue'
import { computed, nextTick, ref, watch } from 'vue'
import { showFailToast, showSuccessToast, showToast } from 'vant'
import CellPicker from '@/shared/CellPicker.vue'
import type { CellOption } from '@/shared/cellPicker'
import { isNativeAvailable } from '@/native/bridge'
import { openSettings } from '@/native/system'
import { canvasToBlob, saveBlob } from '@/shared/image-io'
import { drawQr, makeQr } from '../qrcode-gen/logic'
import { AUTH_OPTIONS, buildWifiPayload, validateWifi, type WifiAuth } from './logic'

/** 画布目标边长 */
const CANVAS_SIZE = 512
/** 二维码边距（模块） */
const QR_BORDER = 4
/** 导出文件名 */
const FILE_NAME = 'wifi-qr.png'
/** 打不开设置页时的提示 */
const OPEN_FAIL = '打不开系统 WiFi 设置'

/** 网络名 */
const ssid = ref('')
/** 密码 */
const password = ref('')
/** 加密类型 */
const auth = ref<WifiAuth>('WPA')
/** 加密方式选项 */
const AUTH_PICK_OPTIONS: CellOption[] = AUTH_OPTIONS.map((o) => ({ value: o.id, label: o.label }))
/** 是否隐藏 */
const hidden = ref(false)
/** 画布元素 */
const canvas = ref<HTMLCanvasElement | null>(null)
/** 保存中 */
const saving = ref(false)
/** 有宿主时才显示系统设置按钮 */
const hasNative = isNativeAvailable()

/** 当前表单值 */
const input = computed(() => ({ ssid: ssid.value, password: password.value, auth: auth.value, hidden: hidden.value }))
/** 输入校验错误（还没填名称时不当错误展示） */
const error = computed(() => (ssid.value ? validateWifi(input.value) : ''))
/** 二维码结果，输入不合法时为 null */
const qr = computed(() => {
  if (!ssid.value || error.value) return null
  const r = makeQr(buildWifiPayload(input.value), 'M')
  return r.ok ? r.value : null
})

/** 重绘二维码 */
async function redraw(): Promise<void> {
  await nextTick()
  const el = canvas.value
  const q = qr.value
  if (!el || !q) return
  const opts = { size: CANVAS_SIZE, border: QR_BORDER, fg: '#000000', bg: '#ffffff' }
  // 先算边长再设宽高（设置宽高会清空画布）
  const side = drawQr({ fillStyle: '', fillRect() {} }, q, opts)
  el.width = side
  el.height = side
  const ctx = el.getContext('2d')
  if (ctx) drawQr(ctx, q, opts)
}
watch(qr, redraw, { flush: 'post' })

/** 保存二维码图片 */
async function save(): Promise<void> {
  if (!canvas.value || !qr.value) return
  saving.value = true
  try {
    const res = await saveBlob(await canvasToBlob(canvas.value, 'image/png'), FILE_NAME)
    showSuccessToast(res.mode === 'native' ? '已保存到相册' : '已开始下载')
  } catch {
    showFailToast('保存失败，请重试')
  } finally {
    saving.value = false
  }
}

/** 打开系统 WiFi 设置 */
async function openWifi(): Promise<void> {
  try {
    if (!(await openSettings('wifi'))) showToast(OPEN_FAIL)
  } catch {
    showToast(OPEN_FAIL)
  }
}
</script>

<template>
  <div class="tool-page">
    <tool-group title="先说明一下">
      <p class="tool-hint">Android 10 以后，系统不允许应用读取已保存的 WiFi 密码，所以这里需要你手动输入。生成的二维码可以给别人扫码连接。</p>
      <van-button v-if="hasNative" size="small" plain type="primary" @click="openWifi">打开系统 WiFi 设置</van-button>
    </tool-group>

    <tool-group title="网络信息">
      <van-field v-model="ssid" label="名称" placeholder="WiFi 名称（SSID）" clearable />
      <van-field v-if="auth !== 'nopass'" v-model="password" label="密码" placeholder="WiFi 密码" clearable />
      <cell-picker :model-value="auth" title="加密方式" :options="AUTH_PICK_OPTIONS" @update:model-value="auth = $event as WifiAuth" />
      <van-cell center title="隐藏网络">
        <template #right-icon><van-switch v-model="hidden" size="20" /></template>
      </van-cell>
      <p v-if="error" class="tool-hint wq-err">{{ error }}</p>
    </tool-group>

    <tool-group v-if="qr" class="wq-preview">
      <canvas ref="canvas" class="wq-canvas" />
      <p class="tool-hint">用另一台手机的相机或扫码工具扫一扫即可连接</p>
    </tool-group>
    <tool-group v-else class="tool-hint wq-empty">填好名称和密码后，二维码会显示在这里</tool-group>

    <!-- 底部动作栏：二维码是实时画出来的，主操作就是保存 -->
    <bottom-actions :main-loading="saving" main main-text="保存二维码" :disabled="{ main: !qr || saving }" @main="save" />
  </div>
</template>

<style lang="scss" scoped>
/* 预览卡片：画布居中 */
.wq-preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: $space-2;
}
.wq-canvas {
  width: 100%;
  max-width: 320px;
  height: auto;
  aspect-ratio: 1;
  image-rendering: pixelated;
  border: 1px solid var(--c-border);
}
.wq-empty {
  text-align: center;
}
.wq-err {
  color: var(--c-error);
}
</style>
