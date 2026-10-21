<script setup lang="ts">
// 网页转应用：给一个网址在桌面建快捷方式，点一下直接打开
import BottomActions from '@/shared/BottomActions.vue'
import { ref, watch } from 'vue'
import { showFailToast, showSuccessToast, showToast } from 'vant'
import { isNativeAvailable } from '@/native/bridge'
import { pinShortcut } from '@/native/shortcut'
import { checkLabel, checkUrl, makeShortcutId, MAX_LABEL, suggestLabel } from './logic'

/** 无宿主时的提示 */
const TIP_NO_HOST = '添加到桌面只能在 Arkli 应用里使用。'

/** 是否在容器内 */
const hosted = isNativeAvailable()
/** 网址输入 */
const url = ref('')
/** 名称输入 */
const label = ref('')
/** 名称是否被用户手改过：改过就不再自动带出 */
const labelTouched = ref(false)
/** 提交中 */
const busy = ref(false)

// 没手改过名称时，按网址自动带出一个
watch(url, (v) => {
  if (labelTouched.value) return
  const r = checkUrl(v)
  label.value = r.ok ? suggestLabel(r.url) : ''
})

/** 提交：校验后请求系统固定快捷方式 */
async function submit(): Promise<void> {
  const u = checkUrl(url.value)
  if (!u.ok) {
    showToast(u.error)
    return
  }
  const err = checkLabel(label.value)
  if (err) {
    showToast(err)
    return
  }
  busy.value = true
  try {
    const r = await pinShortcut({ id: makeShortcutId(u.url), label: label.value.trim(), url: u.url })
    if (r.requested) showSuccessToast('请在弹出的窗口里确认添加')
    else showFailToast('这个桌面不支持添加快捷方式，可在桌面或系统设置里允许')
  } catch (e) {
    showFailToast((e as { message?: string }).message || '添加失败')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="tool-page">
    <van-notice-bar v-if="!hosted" wrapable :scrollable="false" left-icon="info-o">{{ TIP_NO_HOST }}</van-notice-bar>

    <tool-group>
      <van-field v-model="url" label="网址" type="url" placeholder="例如 zhihu.com" clearable />
      <van-field v-model="label" label="名称" placeholder="桌面上显示的名字" :maxlength="MAX_LABEL" clearable @input="labelTouched = true" />
    </tool-group>

    <p class="tool-hint">图标是名称的首字加彩色底。点击快捷方式会用浏览器打开该网址，不是独立的 App。同一网址再次添加会更新原来的。</p>

    <!-- 底部动作栏：主按钮添加到桌面 -->
    <bottom-actions :main-loading="busy" main main-text="添加到桌面" :disabled="{ main: busy || !hosted }" @main="submit" />
  </div>
</template>
