<script setup lang="ts">
// 时间计算器：两个标签页——时刻加减、时刻之差（附时长换算）
import { computed, ref } from 'vue'
import { createToolStorage } from '@/shared/toolStorage'
import { usePersistedRef } from '@/shared/usePersistedRef'
import CellPicker from '@/shared/CellPicker.vue'
import type { CellOption } from '@/shared/cellPicker'
import { addClock, clockDiff, durationUnits, formatDuration, parseHms } from './logic'

/** 本工具的持久缓存 */
const store = createToolStorage('time-calc')
/** 一天的秒数 */
const DAY_SECONDS = 86400

/** 标签页：add 加减 / diff 之差 */
const tab = usePersistedRef<'add' | 'diff'>(store, 'tab', 'add', (v) => v === 'add' || v === 'diff')

/** 加减页：起始时刻 */
const baseText = ref('')
/** 加减页：时长 */
const deltaText = ref('')
/** 加减页：加还是减 */
const sign = usePersistedRef<1 | -1>(store, 'sign', 1, (v) => v === 1 || v === -1)
/** 运算选项：加 / 减 */
const SIGN_OPTIONS: CellOption[] = [
  { value: 1, label: '加' },
  { value: -1, label: '减' },
]
/** 之差页：起时刻 */
const aText = ref('')
/** 之差页：止时刻 */
const bText = ref('')
/** 之差页：止早于起时是否视为次日 */
const crossDay = usePersistedRef(store, 'crossDay', true, (v) => typeof v === 'boolean')

/** 加减结果；输入未填完为 null，有误为错误文本 */
const addResult = computed(() => {
  if (!baseText.value.trim() || !deltaText.value.trim()) return null
  const base = parseHms(baseText.value)
  if (!base.ok) return { error: `起始时刻：${base.error}` }
  if (base.seconds >= DAY_SECONDS) return { error: '起始时刻要在 00:00:00 到 23:59:59 之间' }
  const delta = parseHms(deltaText.value)
  if (!delta.ok) return { error: `时长：${delta.error}` }
  const r = addClock(base.seconds, delta.seconds, sign.value)
  const day = r.dayOffset === 0 ? '当天' : r.dayOffset > 0 ? `第 ${r.dayOffset} 天后` : `${-r.dayOffset} 天前`
  return { text: `${r.time}（${day}）` }
})

/** 之差结果 */
const diffResult = computed(() => {
  if (!aText.value.trim() || !bText.value.trim()) return null
  const a = parseHms(aText.value)
  if (!a.ok) return { error: `起：${a.error}` }
  const b = parseHms(bText.value)
  if (!b.ok) return { error: `止：${b.error}` }
  const sec = clockDiff(a.seconds, b.seconds, crossDay.value)
  return { text: formatDuration(sec), units: durationUnits(sec) }
})
</script>

<template>
  <div class="tool-page">
    <van-tabs v-model:active="tab" type="card">
      <van-tab name="add" title="时间加减" />
      <van-tab name="diff" title="时间差" />
    </van-tabs>

    <template v-if="tab === 'add'">
      <tool-group>
        <van-cell-group>
          <van-field v-model="baseText" label="起始时刻" inputmode="numeric" placeholder="23:30:00" clearable />
          <cell-picker :model-value="sign" title="运算" :options="SIGN_OPTIONS" @update:model-value="sign = $event as 1 | -1" />
          <van-field v-model="deltaText" label="时长" inputmode="numeric" placeholder="02:15:00" clearable />
        </van-cell-group>
        <p class="tool-hint hint">格式 时:分:秒，时长的小时可超过 24。</p>
      </tool-group>
      <p v-if="addResult && 'error' in addResult" class="tool-result tool-result--error">{{ addResult.error }}</p>
      <div v-else-if="addResult" class="tool-result">
        <span class="tool-result__label">结果时刻</span>
        {{ addResult.text }}
      </div>
    </template>

    <template v-else>
      <tool-group>
        <van-cell-group>
          <van-field v-model="aText" label="起" inputmode="numeric" placeholder="09:00:00" clearable />
          <van-field v-model="bText" label="止" inputmode="numeric" placeholder="18:30:00" clearable />
          <van-cell title="止早于起时按次日算">
            <template #right-icon>
              <van-switch v-model="crossDay" size="22" />
            </template>
          </van-cell>
        </van-cell-group>
      </tool-group>
      <p v-if="diffResult && 'error' in diffResult" class="tool-result tool-result--error">{{ diffResult.error }}</p>
      <template v-else-if="diffResult">
        <div class="tool-result">
          <span class="tool-result__label">时间差</span>
          {{ diffResult.text }}
        </div>
        <tool-group title="换算">
          <van-cell v-for="u in diffResult.units" :key="u.name" :title="u.name" :value="String(u.value)" />
        </tool-group>
      </template>
    </template>
  </div>
</template>

<style lang="scss" scoped>
// 提示与输入组之间留点距离
.hint {
  margin-top: 8px;
}

</style>
