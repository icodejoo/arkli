<script setup lang="ts">
// 日期计算器：日期间隔、日期推算两个标签页
import { computed, ref } from 'vue'
import CellPicker from '@/shared/CellPicker.vue'
import { createToolStorage } from '@/shared/toolStorage'
import { usePersistedRef } from '@/shared/usePersistedRef'
import { WEEK_NAMES, dateDiff, dayOfYear, formatDate, parseDate, shiftDate, toDayNumber, weekday, type ShiftUnit } from './logic'

/** 推算单位可选项 */
const UNITS: { value: ShiftUnit; label: string }[] = [
  { value: 'day', label: '天' },
  { value: 'week', label: '周' },
  { value: 'month', label: '个月' },
  { value: 'year', label: '年' },
]
/** 推算方向选项：之后为 1，之前为 -1 */
const SIGN_OPTIONS = [
  { value: 1, label: '之后' },
  { value: -1, label: '之前' },
]
/** 起始日期字段标签 */
const LABEL_START = '起始日期'

/** 持久缓存 */
const store = createToolStorage('date-calc')

/** 标签页：diff 间隔 / shift 推算 */
const tab = usePersistedRef<'diff' | 'shift'>(store, 'tab', 'diff', (v) => v === 'diff' || v === 'shift')
/** 间隔页：起始日期 */
const aText = ref('')
/** 间隔页：结束日期 */
const bText = ref('')
/** 间隔页：是否含首尾 */
const inclusive = usePersistedRef(store, 'inclusive', false, (v) => typeof v === 'boolean')
/** 推算页：起始日期 */
const baseText = ref('')
/** 推算页：数量文本 */
const amountText = ref('')
/** 推算页：单位 */
const unit = usePersistedRef<ShiftUnit>(store, 'unit', 'day', (v) => UNITS.some((u) => u.value === v))
/** 推算页：加或减 */
const sign = usePersistedRef<1 | -1>(store, 'sign', 1, (v) => SIGN_OPTIONS.some((o) => o.value === v))

/**
 * 描述某天的星期与年内序号。
 *
 * @param text 合法日期文本
 * @returns 如「周四，当年第 60 天」
 */
function describeDay(text: string): string {
  const p = parseDate(text)
  if (!p.ok) return ''
  return `${WEEK_NAMES[weekday(toDayNumber(p.value))]}，当年第 ${dayOfYear(p.value)} 天`
}

/** 间隔结果 */
const diffResult = computed(() => {
  if (!aText.value || !bText.value) return null
  const a = parseDate(aText.value)
  if (!a.ok) return { error: `${LABEL_START}：${a.error}` }
  const b = parseDate(bText.value)
  if (!b.ok) return { error: `结束日期：${b.error}` }
  const r = dateDiff(a.value, b.value, inclusive.value)
  const parts = [r.years && `${r.years} 年`, r.months && `${r.months} 个月`, `${r.days} 天`].filter(Boolean)
  return { total: `${r.totalDays} 天`, weeks: `约 ${Math.abs(r.totalDays / 7).toFixed(1)} 周`, ymd: parts.join(' ') }
})

/** 推算结果 */
const shiftResult = computed(() => {
  const n = amountText.value.trim() === '' ? null : Number(amountText.value)
  if (!baseText.value || n === null) return null
  const b = parseDate(baseText.value)
  if (!b.ok) return { error: b.error }
  if (!Number.isInteger(n)) return { error: '数量要填整数' }
  const r = shiftDate(b.value, sign.value * n, unit.value)
  if (!r) return { error: '结果超出支持的年份范围（1 到 9999 年）' }
  const text = formatDate(r)
  return { text, week: describeDay(text) }
})
</script>

<template>
  <div class="tool-page">
    <van-tabs v-model:active="tab" type="card">
      <van-tab name="diff" title="日期间隔" />
      <van-tab name="shift" title="日期推算" />
    </van-tabs>

    <template v-if="tab === 'diff'">
      <tool-group>
        <van-cell-group>
          <van-field v-model="aText" :label="LABEL_START" type="date" />
          <van-field v-model="bText" label="结束日期" type="date" />
          <van-cell title="含首尾（两端都算一天）">
            <template #right-icon>
              <van-switch v-model="inclusive" size="22" />
            </template>
          </van-cell>
        </van-cell-group>
      </tool-group>
      <p v-if="diffResult && 'error' in diffResult" class="tool-result tool-result--error">{{ diffResult.error }}</p>
      <div v-else-if="diffResult" class="tool-result">
        <span class="tool-result__label">相差</span>
        {{ diffResult.total }}
        <span class="tool-result__label sub">{{ diffResult.weeks }}，即 {{ diffResult.ymd }}</span>
      </div>
    </template>

    <template v-else>
      <tool-group>
        <van-cell-group>
          <van-field v-model="baseText" :label="LABEL_START" type="date" />
          <cell-picker :model-value="sign" title="方向" :options="SIGN_OPTIONS" @update:model-value="sign = $event as 1 | -1" />
          <van-field v-model="amountText" label="数量" type="digit" placeholder="整数" clearable />
          <cell-picker :model-value="unit" title="单位" :options="UNITS" @update:model-value="unit = $event as ShiftUnit" />
        </van-cell-group>
      </tool-group>
      <p v-if="shiftResult && 'error' in shiftResult" class="tool-result tool-result--error">{{ shiftResult.error }}</p>
      <div v-else-if="shiftResult" class="tool-result">
        <span class="tool-result__label">推算结果</span>
        {{ shiftResult.text }}
        <span class="tool-result__label sub">{{ shiftResult.week }}</span>
      </div>
    </template>
  </div>
</template>

<style lang="scss" scoped>
// 结果下方的补充说明：与大字拉开一点距离
.sub {
  margin: 4px 0 0;
}

</style>
