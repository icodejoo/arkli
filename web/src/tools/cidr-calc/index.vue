<script setup lang="ts">
// CIDR 计算器：网段详情（IPv4 为主，IPv6 做前缀展开）、IP 是否在网段内、子网划分
import { computed, ref } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import { calcCidr, ipInCidr, MAX_SPLIT_LIST, splitSubnet, type IPv4Result, type IPv6Result } from './logic'

/** 输入的网段 */
const input = ref('192.168.1.0/24')
/** 待判断的 IP */
const testIp = ref('')
/** 子网划分的新前缀（字符串，便于输入） */
const newPrefix = ref('26')

/** 计算结果与错误提示 */
const outcome = computed<{ r: IPv4Result | IPv6Result | null; error: string }>(() => {
  if (!input.value.trim()) return { r: null, error: '' }
  try {
    return { r: calcCidr(input.value), error: '' }
  } catch (e) {
    return { r: null, error: (e as Error).message }
  }
})
/** IPv4 结果（类型收窄用） */
const v4 = computed(() => (outcome.value.r?.version === 4 ? (outcome.value.r as IPv4Result) : null))
/** IPv6 结果 */
const v6 = computed(() => (outcome.value.r?.version === 6 ? (outcome.value.r as IPv6Result) : null))

/** 包含判断结果：null 表示还没输入或不适用 */
const contain = computed<{ ok: boolean | null; msg: string }>(() => {
  if (!v4.value || !testIp.value.trim()) return { ok: null, msg: '' }
  try {
    return { ok: ipInCidr(input.value, testIp.value), msg: '' }
  } catch (e) {
    return { ok: null, msg: (e as Error).message }
  }
})

/** 子网划分结果 */
const split = computed(() => {
  if (!v4.value) return null
  try {
    return { data: splitSubnet(input.value, Number(newPrefix.value)), error: '' }
  } catch (e) {
    return { data: null, error: (e as Error).message }
  }
})

/** 数字加千分位 */
function fmt(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** 复制一段文本 */
async function copy(text: string): Promise<void> {
  if (await copyText(text)) showSuccessToast('已复制')
  else showFailToast('复制失败，请长按文字手动选择')
}
</script>

<template>
  <div class="tool-page">
    <tool-group title="网段">
      <van-field v-model="input" clearable placeholder="192.168.1.0/24、10.0.0.5 255.0.0.0 或 2001:db8::/32" />
      <p v-if="outcome.error" class="tool-hint cidr-err">{{ outcome.error }}</p>
      <p v-else class="tool-hint cidr-gap">支持 IP/前缀、IP/掩码、IP 空格 掩码；含冒号按 IPv6 处理。</p>
    </tool-group>

    <tool-group v-if="v4" title="IPv4 结果（点一行复制）">
      <van-cell title="网络地址" :value="v4.network" @click="copy(v4.network)" />
      <van-cell title="广播地址" :value="v4.broadcast" @click="copy(v4.broadcast)" />
      <van-cell title="子网掩码" :value="`${v4.mask}（/${v4.prefix}）`" @click="copy(v4.mask)" />
      <van-cell title="反掩码" :value="v4.wildcard" @click="copy(v4.wildcard)" />
      <van-cell title="首个可用" :value="v4.first" @click="copy(v4.first)" />
      <van-cell title="末个可用" :value="v4.last" @click="copy(v4.last)" />
      <van-cell title="可用主机数" :value="fmt(v4.hosts)" />
      <van-cell title="地址总数" :value="fmt(v4.total)" />
      <van-cell title="地址类别" :value="`${v4.ipClass} 类 · ${v4.kind}`" />
      <p v-if="v4.prefix >= 31" class="tool-hint cidr-gap">
        {{ v4.prefix === 31 ? '/31 是点对点链路（RFC 3021），两个地址都可用。' : '/32 是单个主机地址。' }}
      </p>
    </tool-group>

    <tool-group v-if="v4" title="二进制">
      <div class="cidr-bin"><span>IP</span><code>{{ v4.binary.ip }}</code></div>
      <div class="cidr-bin"><span>掩码</span><code>{{ v4.binary.mask }}</code></div>
      <div class="cidr-bin"><span>网络</span><code>{{ v4.binary.network }}</code></div>
    </tool-group>

    <tool-group v-if="v6" title="IPv6 结果（点一行复制）">
      <van-cell title="压缩写法" :value="v6.ip" @click="copy(v6.ip)" />
      <van-cell title="展开写法" :value="v6.expanded" @click="copy(v6.expanded)" />
      <van-cell title="网络前缀" :value="`${v6.network}/${v6.prefix}`" @click="copy(`${v6.network}/${v6.prefix}`)" />
      <van-cell title="起始地址" :value="v6.first" @click="copy(v6.first)" />
      <van-cell title="结束地址" :value="v6.last" @click="copy(v6.last)" />
      <van-cell title="地址总数" :value="v6.total" />
      <van-cell v-if="v6.mappedIPv4" title="映射的 IPv4" :value="v6.mappedIPv4" />
    </tool-group>

    <tool-group v-if="v4" title="IP 是否在网段内">
      <van-field v-model="testIp" clearable placeholder="输入要判断的 IPv4" />
      <p v-if="contain.msg" class="tool-hint cidr-err">{{ contain.msg }}</p>
      <p v-else-if="contain.ok !== null" class="tool-hint cidr-gap" :class="contain.ok ? 'cidr-ok' : 'cidr-err'">
        {{ contain.ok ? '在这个网段内' : '不在这个网段内' }}
      </p>
    </tool-group>

    <tool-group v-if="v4" title="子网划分">
      <van-field v-model="newPrefix" type="digit" label="拆成 /" input-align="right" />
      <template v-if="split">
        <p v-if="split.error" class="tool-hint cidr-err">{{ split.error }}</p>
        <template v-else-if="split.data">
          <p class="tool-hint cidr-gap">
            共 {{ fmt(split.data.count) }} 个子网<template v-if="split.data.count > MAX_SPLIT_LIST">，只列前 {{ MAX_SPLIT_LIST }} 个</template>
          </p>
          <div v-for="s in split.data.subnets" :key="s.network" class="cidr-sub" @click="copy(`${s.network}/${newPrefix}`)">
            <b>{{ s.network }}/{{ newPrefix }}</b>
            <span>{{ s.first }} ~ {{ s.last }}（{{ fmt(s.hosts) }} 台）</span>
          </div>
        </template>
      </template>
    </tool-group>
  </div>
</template>

<style lang="scss" scoped>
.cidr-gap {
  margin-top: $space-2;
}
.cidr-err {
  margin-top: $space-2;
  color: var(--c-error);
}
.cidr-ok {
  color: var(--van-success-color);
}
.cidr-bin {
  display: flex;
  gap: $space-2;
  padding: 4px 0;

  span {
    flex: none;
    width: 36px;
    font-size: 12px;
    color: var(--c-text-muted);
  }
  code {
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-size: 12px;
    word-break: break-all;
  }
}
.cidr-sub {
  display: flex;
  flex-direction: column;
  padding: 6px 0;
  border-bottom: 1px solid var(--c-border);
  font-size: 13px;

  span {
    font-size: 12px;
    color: var(--c-text-muted);
    word-break: break-all;
  }
}
</style>
