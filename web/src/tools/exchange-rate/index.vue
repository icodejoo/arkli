<script setup lang="ts">
// 汇率换算：联网取汇率（主备两个源），断网用缓存，再不行可手动输入汇率
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { isNativeAvailable } from '@/native/bridge'
import {
  CURRENCIES, currencyLabel, decimalsFor, fetchRates, formatCachedAt, formatConverted, formatRate, parseAmount, parseRate, readCache,
  writeCache, type RateTable,
} from './logic'

/** 选币种弹窗要改的是哪一边 */
type Side = 'from' | 'to'

/** 是否在 App 内 */
const inApp = isNativeAvailable()
/** 金额输入 */
const amount = ref('100')
/** 源币种 */
const from = ref('CNY')
/** 目标币种 */
const to = ref('USD')
/** 当前汇率表（联网或缓存） */
const table = ref<RateTable | null>(null)
/** 汇率表来自缓存时的缓存时间戳，联网取到的为 null */
const cachedAt = ref<number | null>(null)
/** 手动输入的汇率 */
const manualRate = ref('')
/** 加载中 */
const loading = ref(false)
/** 联网失败提示 */
const netError = ref('')
/** 币种选择弹窗是否显示 */
const pickerOpen = ref(false)
/** 弹窗正在选的一边 */
const pickSide = ref<Side>('from')
/** 当前请求的取消器 */
let ac: AbortController | null = null

/** 选择器的列 */
const columns = CURRENCIES.map((c) => ({ text: currencyLabel(c.code), value: c.code }))
/** 目标币种的小数位 */
const decimals = computed(() => decimalsFor(to.value))
/** 汇率：同币种为 1；有表用表；没表用手动输入 */
const rate = computed<number | null>(() => {
  if (from.value === to.value) return 1
  const r = table.value?.rates[to.value]
  if (r) return r
  return table.value ? null : parseRate(manualRate.value)
})
/** 换算结果文本 */
const result = computed(() => {
  const a = parseAmount(amount.value)
  return a === null || rate.value === null ? '' : formatConverted(a, rate.value, decimals.value)
})
/** 需要手动输入汇率：没有汇率表且币种不同 */
const needManual = computed(() => !table.value && from.value !== to.value && !loading.value)
/** 数据来源说明 */
const sourceText = computed(() => {
  const t = table.value
  if (!t || from.value === to.value) return ''
  const src = t.source === 'frankfurter' ? 'frankfurter.dev（欧洲央行）' : 'open.er-api.com'
  return `${src}，汇率日期 ${t.date || '未知'}`
})

/** 取汇率：联网成功就缓存；失败回退缓存；都没有就等手动输入 */
async function load(): Promise<void> {
  ac?.abort()
  const mine = new AbortController()
  ac = mine
  const base = from.value
  const target = to.value
  netError.value = ''
  if (base === target) {
    loading.value = false
    return
  }
  loading.value = true
  try {
    if (!inApp) throw new Error('需要在 App 内才能联网取汇率')
    const t = await fetchRates(base, target, undefined, mine.signal)
    if (ac !== mine) return
    table.value = t
    cachedAt.value = null
    writeCache(t, Date.now())
  } catch (e) {
    if (ac !== mine) return
    netError.value = (e as { message?: string }).message || '取汇率失败'
    const c = readCache(base)
    if (c && c.table.rates[target]) {
      table.value = c.table
      cachedAt.value = c.savedAt
    } else {
      table.value = null
      cachedAt.value = null
    }
  } finally {
    if (ac === mine) {
      loading.value = false
      ac = null
    }
  }
}

/** 打开币种选择 */
function openPicker(side: Side): void {
  pickSide.value = side
  pickerOpen.value = true
}

/** 选中币种 */
function onConfirm(e: { selectedValues: Array<string | number> }): void {
  const code = String(e.selectedValues[0])
  if (pickSide.value === 'from') from.value = code
  else to.value = code
  pickerOpen.value = false
}

/** 互换两个币种 */
function swap(): void {
  const f = from.value
  from.value = to.value
  to.value = f
}

watch([from, to], load)
load()

onBeforeUnmount(() => {
  const cur = ac
  ac = null
  cur?.abort()
})
</script>

<template>
  <div class="tool-page">
    <div class="tool-card">
      <h3 class="tool-card__title">金额</h3>
      <van-field v-model="amount" type="number" inputmode="decimal" clearable placeholder="输入金额" />
      <div class="er-pair">
        <van-button plain class="er-cur" @click="openPicker('from')">{{ currencyLabel(from) }}</van-button>
        <van-button icon="exchange" size="small" round class="er-swap" aria-label="互换" @click="swap" />
        <van-button plain class="er-cur" @click="openPicker('to')">{{ currencyLabel(to) }}</van-button>
      </div>
    </div>

    <div class="tool-card">
      <h3 class="tool-card__title">结果</h3>
      <p v-if="loading" class="tool-hint">正在取汇率…</p>
      <template v-else>
        <p v-if="result" class="er-result">{{ result }} <small>{{ to }}</small></p>
        <p v-else class="tool-hint">{{ parseAmount(amount) === null ? '请输入正确的金额' : '还没有汇率' }}</p>
        <p v-if="rate !== null" class="tool-hint">1 {{ from }} ≈ {{ formatRate(rate) }} {{ to }}</p>
      </template>

      <p v-if="cachedAt !== null" class="tool-hint er-warn">网络不可用，使用缓存于 {{ formatCachedAt(cachedAt) }} 的汇率。</p>
      <p v-else-if="netError && !table" class="tool-hint er-warn">{{ netError }}</p>

      <van-field
        v-if="needManual"
        v-model="manualRate"
        type="number"
        inputmode="decimal"
        :label="`1 ${from} =`"
        :placeholder="`手动输入汇率（${to}）`"
      />
      <van-button v-if="inApp" size="small" plain class="er-refresh" :loading="loading" @click="load">刷新汇率</van-button>
    </div>

    <p class="tool-hint er-src">
      <template v-if="sourceText">数据来源：{{ sourceText }}。</template>
      汇率仅供参考，实际成交以银行或平台为准。
    </p>

    <van-popup v-model:show="pickerOpen" position="bottom" round>
      <van-picker :columns="columns" :model-value="[pickSide === 'from' ? from : to]" @confirm="onConfirm" @cancel="pickerOpen = false" />
    </van-popup>
  </div>
</template>

<style lang="scss" scoped>
.er-pair {
  display: flex;
  align-items: center;
  gap: $space-2;
  margin-top: $space-2;
}
.er-cur {
  flex: 1;
  min-width: 0;
}
.er-swap {
  flex: none;
}
.er-result {
  margin: 0 0 $space-1;
  font-size: 26px;
  font-weight: 600;
  color: var(--c-primary);
  word-break: break-all;

  small {
    font-size: 14px;
    font-weight: 400;
  }
}
.er-warn {
  color: var(--c-error);
}
.er-refresh {
  margin-top: $space-2;
}
.er-src {
  padding: 0 $space-2;
}
</style>
