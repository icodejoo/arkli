<script setup lang="ts">
// 密码生成器：选长度与字符集，一次生成 1~20 个，可逐个复制
import { computed, reactive, ref } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import {
  CHARSETS,
  DEFAULT_OPTIONS,
  entropyBits,
  generateBatch,
  MAX_COUNT,
  MAX_LENGTH,
  MIN_COUNT,
  MIN_LENGTH,
  strengthOf,
  validateOptions,
  type CharsetKey,
  type PasswordOptions,
  type Strength,
} from './logic'

/** 强度进度条满格对应的熵值（bit） */
const FULL_BITS = 128

/** 字符集的展示名 */
const SET_LABELS: Record<CharsetKey, string> = { upper: '大写 A-Z', lower: '小写 a-z', digits: '数字 0-9', symbols: '符号 !@#' }
/** 强度的展示名与颜色变量 */
const STRENGTH_VIEW: Record<Strength, { text: string; color: string }> = {
  weak: { text: '弱', color: 'var(--c-error)' },
  fair: { text: '一般', color: 'var(--c-warn-text)' },
  good: { text: '良好', color: 'var(--c-primary)' },
  strong: { text: '很强', color: 'var(--c-ok)' },
}
/** 字符集键列表，用于渲染 */
const SET_KEYS = Object.keys(CHARSETS) as CharsetKey[]

/** 选项（可编辑副本） */
const opts = reactive<PasswordOptions>({ ...DEFAULT_OPTIONS, sets: { ...DEFAULT_OPTIONS.sets } })
/** 批量个数 */
const count = ref(1)
/** 生成结果 */
const list = ref<string[]>([])

/** 校验错误 */
const error = computed(() => validateOptions(opts) ?? (Number.isInteger(count.value) && count.value >= MIN_COUNT && count.value <= MAX_COUNT ? null : `个数需在 ${MIN_COUNT} ~ ${MAX_COUNT} 之间`))
/** 熵值 */
const bits = computed(() => entropyBits(opts))
/** 强度展示 */
const strength = computed(() => STRENGTH_VIEW[strengthOf(bits.value)])
/** 强度进度条百分比 */
const strengthPercent = computed(() => Math.min(100, Math.round((bits.value / FULL_BITS) * 100)))

/** 生成 */
function generate(): void {
  if (error.value) return
  list.value = generateBatch(opts, count.value)
}

/** 复制某一个密码 */
async function copy(pw: string): Promise<void> {
  if (await copyText(pw)) showSuccessToast('已复制，用完记得清理剪贴板')
  else showFailToast('复制失败，请长按密码手动选择')
}

generate()
</script>

<template>
  <div class="tool-page">
    <div class="tool-card">
      <van-cell-group :border="false">
        <van-cell v-for="(pw, i) in list" :key="i" center>
          <template #title><code class="pw">{{ pw }}</code></template>
          <template #right-icon>
            <van-button size="small" plain icon="description-o" class="pw-copy" @click="copy(pw)">复制</van-button>
          </template>
        </van-cell>
      </van-cell-group>
      <div class="pw-meter">
        <span>强度 <b :style="{ color: strength.color }">{{ strength.text }}</b></span>
        <span class="tool-hint">约 {{ Math.round(bits) }} bit</span>
      </div>
      <van-progress :percentage="strengthPercent" :color="strength.color" :show-pivot="false" stroke-width="6" />
    </div>

    <div class="tool-card">
      <van-cell-group :border="false">
        <van-cell title="长度" :value="String(opts.length)" />
      </van-cell-group>
      <div class="pw-slider">
        <van-slider v-model="opts.length" :min="MIN_LENGTH" :max="MAX_LENGTH" />
      </div>
      <van-cell-group :border="false">
        <van-cell v-for="k in SET_KEYS" :key="k" :title="SET_LABELS[k]" center>
          <template #right-icon><van-switch v-model="opts.sets[k]" size="22" /></template>
        </van-cell>
        <van-cell title="排除易混字符" label="0 O 1 l I" center>
          <template #right-icon><van-switch v-model="opts.excludeAmbiguous" size="22" /></template>
        </van-cell>
        <van-cell title="每类至少一个" center>
          <template #right-icon><van-switch v-model="opts.ensureEach" size="22" /></template>
        </van-cell>
        <van-cell title="个数" center>
          <template #value><van-stepper v-model="count" :min="MIN_COUNT" :max="MAX_COUNT" integer /></template>
        </van-cell>
      </van-cell-group>
      <p v-if="error" class="tool-hint pw-error" role="alert">{{ error }}</p>
    </div>

    <van-button type="primary" block round :disabled="!!error" @click="generate">重新生成</van-button>
  </div>
</template>

<style lang="scss" scoped>
/* 密码文本：等宽、可整段选中 */
.pw {
  font: 16px/1.4 ui-monospace, Menlo, Consolas, monospace;
  word-break: break-all;
  user-select: all;
  color: var(--c-text);
}

/* 复制按钮与密码留距 */
.pw-copy {
  margin-left: $space-2;
  flex-shrink: 0;
}

/* 强度行 */
.pw-meter {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: $space-3 0 $space-2;
  font-size: 15px;
}

/* 滑杆留出触控空间 */
.pw-slider {
  padding: $space-2 $space-3 $space-3;
}

/* 校验错误 */
.pw-error {
  margin-top: $space-2;
  color: var(--c-error);
}
</style>
