<script setup lang="ts">
// 进制转换：选输入进制，一次显示 2/8/10/16 和自定义进制，并给补码
import { computed, ref } from 'vue'
import {
  BIT_WIDTHS,
  COMMON_BASES,
  MAX_BASE,
  MIN_BASE,
  formatInBase,
  parseInBase,
  supportsBigInt,
  twosComplement,
  type BitWidth,
} from './logic'

/** 自定义进制的默认值 */
const DEFAULT_CUSTOM_BASE = 36
/** 默认补码位宽 */
const DEFAULT_BITS: BitWidth = 32
/** 默认输入进制 */
const DEFAULT_FROM_BASE = 10
/** 单选里表示“自定义”的标记值 */
const CUSTOM_FLAG = 0

/** 当前环境是否支持 BigInt */
const bigintOk = supportsBigInt()
/** 输入文本 */
const text = ref('')
/** 输入进制 */
const fromBase = ref<number>(DEFAULT_FROM_BASE)
/** 自定义进制文本（2 到 36） */
const customText = ref(String(DEFAULT_CUSTOM_BASE))
/** 补码位宽 */
const bits = ref<BitWidth>(DEFAULT_BITS)

/** 自定义进制数值；空串为 NaN */
const customBase = computed(() => (customText.value.trim() === '' ? NaN : Number(customText.value)))

/** 自定义进制是否合法 */
const customValid = computed(
  () => Number.isInteger(customBase.value) && customBase.value >= MIN_BASE && customBase.value <= MAX_BASE,
)

/** 选中的输入进制是否为自定义 */
const useCustom = computed(() => !COMMON_BASES.includes(fromBase.value as 2))

/** 单选当前值：常用进制或自定义标记 */
const radioValue = computed(() => (useCustom.value ? CUSTOM_FLAG : fromBase.value))

/** 自定义进制行内错误 */
const customError = computed(() => (customValid.value ? '' : `进制要是 ${MIN_BASE} 到 ${MAX_BASE} 的整数`))

/** 解析结果；输入为空或不支持 BigInt 时为 null */
const parsed = computed(() => {
  if (!bigintOk || !text.value.trim()) return null
  return parseInBase(text.value, fromBase.value)
})

/** 输入框行内错误 */
const inputError = computed(() => (parsed.value && !parsed.value.ok ? parsed.value.error : ''))

/** 各进制输出行 */
const rows = computed(() => {
  if (!parsed.value?.ok) return []
  const v = parsed.value.value
  const list = COMMON_BASES.map((b) => ({ label: `${b} 进制`, value: formatInBase(v, b) }))
  if (customValid.value) list.push({ label: `${customBase.value} 进制`, value: formatInBase(v, customBase.value) })
  return list
})

/** 补码输出；仅当输入为负数时显示，越界为 '' */
const twos = computed(() => {
  if (!parsed.value?.ok || parsed.value.value >= 0n) return null
  return twosComplement(parsed.value.value, bits.value) ?? ''
})

/**
 * 切换输入进制。
 *
 * @param b 进制；传 CUSTOM_FLAG 表示自定义
 */
function pick(b: number | string): void {
  const n = Number(b)
  if (n === CUSTOM_FLAG) fromBase.value = customValid.value ? customBase.value : DEFAULT_CUSTOM_BASE
  else fromBase.value = n
}

/** 自定义进制变化时，若正选中自定义且合法则同步输入进制 */
function onCustomInput(): void {
  if (useCustom.value && customValid.value) fromBase.value = customBase.value
}
</script>

<template>
  <div class="tool-page">
    <van-notice-bar v-if="!bigintOk" wrapable :scrollable="false" color="var(--c-error)">
      当前 WebView 太旧，不支持大整数，请升级系统 WebView 后再试。
    </van-notice-bar>
    <template v-else>
      <div class="tool-card">
        <p class="tool-card__title">输入进制</p>
        <van-radio-group :model-value="radioValue" direction="horizontal" @update:model-value="pick">
          <van-radio v-for="b in COMMON_BASES" :key="b" :name="b">{{ b }}</van-radio>
          <van-radio :name="CUSTOM_FLAG">自定义</van-radio>
        </van-radio-group>
        <van-field
          v-if="useCustom"
          v-model="customText"
          class="gap"
          :label="`进制（${MIN_BASE}-${MAX_BASE}）`"
          type="digit"
          :error-message="customError"
          @update:model-value="onCustomInput"
        />
      </div>

      <div class="tool-card">
        <van-field
          v-model="text"
          label="数值"
          type="text"
          autocapitalize="off"
          autocomplete="off"
          placeholder="输入整数，可带负号"
          clearable
          :error-message="inputError"
        />
        <p v-if="!parsed" class="tool-hint gap">支持任意长整数，不支持小数。</p>
      </div>

      <van-cell-group v-if="rows.length" class="tool-group" title="转换结果">
        <van-cell v-for="r in rows" :key="r.label" :title="r.label">
          <template #label>
            <span class="mono">{{ r.value }}</span>
          </template>
        </van-cell>
      </van-cell-group>

      <div v-if="twos !== null" class="tool-card">
        <p class="tool-card__title">补码位宽</p>
        <van-radio-group v-model="bits" direction="horizontal">
          <van-radio v-for="w in BIT_WIDTHS" :key="w" :name="w">{{ w }}</van-radio>
        </van-radio-group>
        <div v-if="twos" class="tool-result tool-result--text mono gap">{{ twos }}</div>
        <p v-else class="tool-result tool-result--error gap">超出 {{ bits }} 位能表示的范围</p>
      </div>
    </template>
  </div>
</template>

<style lang="scss" scoped>
// 块与块之间的小间距
.gap {
  margin-top: 12px;
}

// 等宽字体，便于对齐数字，允许选中
.mono {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  word-break: break-all;
  user-select: text;
  color: var(--c-text);
}
</style>
