<script setup lang="ts">
// IP 查询：输入 IP 或域名，或查本机公网 IP；只展示国家代码、运营商 / ASN、主机名，不展示城市与经纬度
import BottomActions from '@/shared/BottomActions.vue'
import { computed, onBeforeUnmount, ref } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import { isNativeAvailable } from '@/native/bridge'
import { netResolve } from '@/native/net'
import { copyText } from '@/shared/clipboard'
import { classifyInput, lookupIp, lookupMyIp, pickAddress, type IpInfo } from './logic'

/** 数据来源显示名 */
const SOURCE_TEXT = { ipinfo: 'ipinfo.io', rdap: 'RDAP（rdap.org）' } as const

/** 是否在 App 内 */
const inApp = isNativeAvailable()
/** 输入 */
const input = ref('')
/** 查询中 */
const loading = ref(false)
/** 错误提示 */
const error = ref('')
/** 域名解析出的地址说明 */
const resolvedNote = ref('')
/** 查询结果 */
const info = ref<IpInfo | null>(null)
/** 当前请求的取消器 */
let ac: AbortController | null = null

/** 结果条目，没有的字段不显示 */
const rows = computed<Array<[string, string]>>(() => {
  const i = info.value
  if (!i) return []
  const list: Array<[string, string]> = [['IP', i.ip]]
  const add = (k: string, v: string | null): void => {
    if (v) list.push([k, v])
  }
  add('国家 / 地区', i.country)
  add('运营商', i.org)
  add('ASN', i.asn)
  add('主机名', i.hostname)
  add('网段名称', i.name)
  add('句柄', i.handle)
  add('地址范围', i.range)
  add('CIDR', i.cidrs.join('、'))
  return list
})

/**
 * 统一跑一次查询，处理加载态、取消与卸载后不更新。
 *
 * @param task 具体查询，拿到取消信号
 */
async function run(task: (signal: AbortSignal) => Promise<IpInfo>): Promise<void> {
  error.value = ''
  info.value = null
  loading.value = true
  const mine = new AbortController()
  ac = mine
  try {
    const r = await task(mine.signal)
    if (ac === mine) info.value = r
  } catch (e) {
    if (ac === mine) error.value = mine.signal.aborted ? '已取消' : (e as { message?: string }).message || '查询失败'
  } finally {
    if (ac === mine) {
      loading.value = false
      ac = null
    }
  }
}

/** 查输入的 IP / 域名；进行中再点等于取消 */
async function lookup(): Promise<void> {
  if (loading.value) {
    ac?.abort()
    return
  }
  const c = classifyInput(input.value)
  if (c.kind === 'invalid') {
    error.value = '请输入合法的 IP 或域名'
    return
  }
  resolvedNote.value = ''
  await run(async (signal) => {
    if (c.kind !== 'domain') return lookupIp(c.value, undefined, signal)
    const r = await netResolve(c.value, undefined, signal)
    const ip = pickAddress(r.addresses)
    if (!ip) throw new Error('域名没有解析出地址')
    resolvedNote.value = `${c.value} 解析为 ${r.addresses.map((a) => a.ip).join('、')}，查询的是 ${ip}`
    return lookupIp(ip, undefined, signal)
  })
}

/** 查本机公网 IP */
async function lookupSelf(): Promise<void> {
  if (loading.value) return
  resolvedNote.value = ''
  await run((signal) => lookupMyIp(undefined, signal))
}

/** 复制全部结果 */
async function copyAll(): Promise<void> {
  if (await copyText(rows.value.map(([k, v]) => `${k}：${v}`).join('\n'))) showSuccessToast('已复制')
  else showFailToast('复制失败')
}

onBeforeUnmount(() => {
  const cur = ac
  ac = null
  cur?.abort()
})
</script>

<template>
  <div class="tool-page">
    <tool-group v-if="!inApp">
      <p class="tool-hint">需要在 App 内使用：查询由 App 原生发出，浏览器里没法直接联网。</p>
    </tool-group>

    <tool-group title="IP 或域名">
      <van-field v-model="input" clearable placeholder="8.8.8.8、2001:db8::1 或 example.com" :disabled="!inApp" @keyup.enter="lookup" />
      <div class="ip-actions">
        <van-button plain :disabled="!inApp || loading" @click="lookupSelf">本机公网 IP</van-button>
      </div>
      <p v-if="error" class="tool-hint ip-error">{{ error }}</p>
      <p class="tool-hint">数据来自 ipinfo.io，查不到时用 RDAP（rdap.org）。只显示国家、运营商和主机名，不显示城市与经纬度。</p>
    </tool-group>

    <tool-group v-if="info" :title="`结果（来源：${SOURCE_TEXT[info.source]}）`">
      <p v-if="resolvedNote" class="tool-hint ip-note">{{ resolvedNote }}</p>
      <div v-for="[k, v] in rows" :key="k" class="ip-row">
        <span class="ip-k">{{ k }}</span>
        <span class="ip-v">{{ v }}</span>
      </div>
    </tool-group>

    <!-- 底部动作栏：复制结果，主按钮查询（查询中变成取消） -->
    <bottom-actions :actions="{ copy: { disabled: !info } }" main :main-text="loading ? '取消' : '查询'" :main-type="loading ? 'danger' : 'primary'" :disabled="{ main: !inApp }" @main="lookup" @copy="copyAll" />
  </div>
</template>

<style lang="scss" scoped>
.ip-actions {
  display: flex;
  gap: $space-2;
  margin-top: $space-2;
}
.ip-error {
  color: var(--c-error);
}
.ip-note {
  margin-bottom: $space-2;
  word-break: break-all;
}
.ip-row {
  display: flex;
  gap: $space-2;
  padding: $space-1 0;
  font-size: 14px;
}
.ip-k {
  flex: none;
  width: 78px;
  color: var(--c-text-muted);
}
.ip-v {
  word-break: break-all;
}
</style>
