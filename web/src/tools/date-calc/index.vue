<script setup lang="ts">
// 日期计算器：日期间隔、日期推算两个标签页
import { computed, ref } from 'vue'
import { WEEK_NAMES, dateDiff, dayOfYear, formatDate, parseDate, shiftDate, toDayNumber, weekday, type ShiftUnit } from './logic'

/** 推算单位可选项 */
const UNITS: { value: ShiftUnit; label: string }[] = [
  { value: 'day', label: '天' },
  { value: 'week', label: '周' },
  { value: 'month', label: '个月' },
  { value: 'year', label: '年' },
]
/** 起始日期字段标签 */
const LABEL_START = '起始日期'

/** 标签页：diff 间隔 / shift 推算 */
const tab = ref<'diff' | 'shift'>('diff')
/** 间隔页：起始日期 */
const aText = ref('')
/** 间隔页：结束日期 */
const bText = ref('')
/** 间隔页：是否含首尾 */
const inclusive = ref(false)
/** 推算页：起始日期 */
const baseText = ref('')
/** 推算页：数量文本 */
const amountText = ref('')
/** 推算页：单位 */
const unit = ref<ShiftUnit>('day')
/** 推算页：加或减 */
const sign = ref<1 | -1>(1)

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
      <div class="tool-card">
        <van-cell-group>
          <van-field v-model="aText" :label="LABEL_START" type="date" />
          <van-field v-model="bText" label="结束日期" type="date" />
          <van-cell title="含首尾（两端都算一天）">
            <template #right-icon>
              <van-switch v-model="inclusive" size="22" />
            </template>
          </van-cell>
        </van-cell-group>
      </div>
      <p v-if="diffResult && 'error' in diffResult" class="tool-result tool-result--error">{{ diffResult.error }}</p>
      <div v-else-if="diffResult" class="tool-result">
        <span class="tool-result__label">相差</span>
        {{ diffResult.total }}
        <span class="tool-result__label sub">{{ diffResult.weeks }}，即 {{ diffResult.ymd }}</span>
      </div>
    </template>

    <template v-else>
      <div class="tool-card">
        <van-cell-group>
          <van-field v-model="baseText" :label="LABEL_START" type="date" />
          <van-field label="方向">
            <template #input>
              <van-radio-group v-model="sign" direction="horizontal">
                <van-radio :name="1">之后</van-radio>
                <van-radio :name="-1">之前</van-radio>
              </van-radio-group>
            </template>
          </van-field>
          <van-field v-model="amountText" label="数量" type="digit" placeholder="整数" clearable />
          <van-field label="单位">
            <template #input>
              <van-radio-group v-model="unit" direction="horizontal">
                <van-radio v-for="u in UNITS" :key="u.value" :name="u.value">{{ u.label }}</van-radio>
              </van-radio-group>
            </template>
          </van-field>
        </van-cell-group>
      </div>
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
