<script setup lang="ts">
// UA 解析：默认填入本机 UA，也可以粘贴任意 UA 看浏览器、引擎、系统、设备
import { computed, ref } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import { deviceTypeLabel, parseUA, type NameVersion } from './logic'

/** 本机 UA，非浏览器环境为空 */
const OWN_UA = typeof navigator !== 'undefined' ? navigator.userAgent : ''
/** 未识别时的占位 */
const UNKNOWN = '未识别'

/** 输入的 UA */
const input = ref(OWN_UA)
/** 解析结果 */
const result = computed(() => parseUA(input.value))

/** 名称 + 版本拼成一行文字 */
function nv(x: NameVersion): string {
  if (!x.name) return UNKNOWN
  return x.version ? `${x.name} ${x.version}` : x.name
}

/** 结果行列表 */
const rows = computed(() => {
  const r = result.value
  const d = r.device
  return [
    { label: '浏览器', value: nv(r.browser) },
    { label: '渲染引擎', value: nv(r.engine) },
    { label: '操作系统', value: nv(r.os) },
    { label: '设备类型', value: deviceTypeLabel(d.type) },
    { label: '品牌', value: d.brand ?? UNKNOWN },
    { label: '型号', value: d.model ?? UNKNOWN },
  ]
})

/** 恢复成本机 UA */
function useOwn(): void {
  input.value = OWN_UA
}

/** 复制某一行的值 */
async function copy(text: string): Promise<void> {
  if (await copyText(text)) showSuccessToast('已复制')
  else showFailToast('复制失败，请长按文字手动选择')
}
</script>

<template>
  <div class="tool-page">
    <div class="tool-card">
      <h3 class="tool-card__title">User-Agent</h3>
      <van-field v-model="input" type="textarea" rows="3" autosize clearable placeholder="粘贴要解析的 UA" />
      <div class="ua-actions">
        <van-button size="small" plain @click="useOwn">用本机 UA</van-button>
        <van-button size="small" plain :disabled="!input" @click="copy(input)">复制 UA</van-button>
      </div>
    </div>

    <div class="tool-card">
      <h3 class="tool-card__title">解析结果（点一行复制）</h3>
      <van-cell v-for="r in rows" :key="r.label" :title="r.label" :value="r.value" @click="copy(r.value)" />
      <p class="tool-hint ua-note">
        UA 可以伪造。Windows 10 与 11 的 UA 相同，iPad 的“桌面版网站”会伪装成 Mac，品牌是按型号规则猜的，仅供参考。
      </p>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.ua-actions {
  display: flex;
  gap: $space-2;
  margin-top: $space-2;
}
.ua-note {
  margin-top: $space-2;
}
</style>
