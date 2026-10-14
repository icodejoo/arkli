<script setup lang="ts">
// WiFi 二维码：输入名称与密码，生成可扫码连接的二维码（系统不允许读取已保存密码）
import { computed, nextTick, ref, watch } from 'vue'
import { showFailToast, showSuccessToast, showToast } from 'vant'
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
    <div class="tool-card">
      <h3 class="tool-card__title">先说明一下</h3>
      <p class="tool-hint">Android 10 以后，系统不允许应用读取已保存的 WiFi 密码，所以这里需要你手动输入。生成的二维码可以给别人扫码连接。</p>
      <van-button v-if="hasNative" size="small" plain type="primary" @click="openWifi">打开系统 WiFi 设置</van-button>
    </div>

    <div class="tool-card">
      <h3 class="tool-card__title">网络信息</h3>
      <van-field v-model="ssid" label="名称" placeholder="WiFi 名称（SSID）" clearable />
      <van-field v-if="auth !== 'nopass'" v-model="password" label="密码" placeholder="WiFi 密码" clearable />
      <van-radio-group v-model="auth" direction="horizontal" class="wq-auth">
        <van-radio v-for="o in AUTH_OPTIONS" :key="o.id" :name="o.id">{{ o.label }}</van-radio>
      </van-radio-group>
      <van-cell center title="隐藏网络">
        <template #right-icon><van-switch v-model="hidden" size="20" /></template>
      </van-cell>
      <p v-if="error" class="tool-hint wq-err">{{ error }}</p>
    </div>

    <div v-if="qr" class="tool-card wq-preview">
      <canvas ref="canvas" class="wq-canvas" />
      <p class="tool-hint">用另一台手机的相机或扫码工具扫一扫即可连接</p>
    </div>
    <div v-else class="tool-card tool-hint wq-empty">填好名称和密码后，二维码会显示在这里</div>

    <div class="tool-actions">
      <van-button type="primary" :disabled="!qr" :loading="saving" @click="save">保存二维码</van-button>
    </div>
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
.wq-auth {
  margin: $space-3 0;
}
.wq-err {
  color: var(--c-error);
}
</style>
