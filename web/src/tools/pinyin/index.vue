<script setup lang="ts">
// 中文转拼音：首次点"转换"才加载拼音词典（体积大），之后改选项自动重算
import { ref, watch } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import { convertPinyin, DEFAULT_OPTIONS, loadPinyin, type PinyinLib, type PinyinOptions, type PinyinResult } from './logic'

/** 输入 */
const input = ref('')
/** 转换选项 */
const opts = ref<PinyinOptions>({ ...DEFAULT_OPTIONS })
/** 转换结果，null 表示还没转换 */
const result = ref<PinyinResult | null>(null)
/** 词典加载中 */
const loading = ref(false)
/** 错误提示 */
const error = ref('')
/** 已加载的库（只加载一次） */
let lib: PinyinLib | undefined

/** 分隔符预设：空格 / 无 / 连字符 / 下划线 */
const SEPARATORS = [
  { label: '空格', value: ' ' },
  { label: '无', value: '' },
  { label: '-', value: '-' },
  { label: '_', value: '_' },
]

/** 转换：必要时先加载词典 */
async function run(): Promise<void> {
  if (!input.value.trim()) {
    showFailToast('先输入点中文')
    return
  }
  error.value = ''
  try {
    if (!lib) {
      loading.value = true
      lib = await loadPinyin()
    }
    result.value = convertPinyin(lib, input.value, opts.value)
  } catch (e) {
    error.value = e instanceof RangeError ? e.message : '加载拼音词典失败，请重试'
  } finally {
    loading.value = false
  }
}

// 转换过一次后，选项或输入变化自动重算
watch([opts, input], () => {
  if (result.value && lib) {
    try {
      result.value = convertPinyin(lib, input.value, opts.value)
      error.value = ''
    } catch (e) {
      error.value = e instanceof RangeError ? e.message : '转换失败'
    }
  }
}, { deep: true })

/** 复制结果 */
async function copy(): Promise<void> {
  if (!result.value?.text) return
  if (await copyText(result.value.text)) showSuccessToast('已复制')
  else showFailToast('复制失败，请长按文字手动选择')
}
</script>

<template>
  <div class="tool-page">
    <div class="tool-card">
      <h3 class="tool-card__title">中文</h3>
      <van-field v-model="input" type="textarea" rows="3" autosize clearable placeholder="输入要转换的文字，如：你好，世界" :error-message="error" />
    </div>

    <div class="tool-card">
      <h3 class="tool-card__title">声调</h3>
      <van-radio-group v-model="opts.tone" direction="horizontal">
        <van-radio name="mark">带声调</van-radio>
        <van-radio name="num">数字声调</van-radio>
        <van-radio name="none">无声调</van-radio>
      </van-radio-group>
      <h3 class="tool-card__title py-gap">样式</h3>
      <van-radio-group v-model="opts.pattern" direction="horizontal">
        <van-radio name="full">全拼</van-radio>
        <van-radio name="first">首字母</van-radio>
      </van-radio-group>
      <h3 class="tool-card__title py-gap">分隔符</h3>
      <van-radio-group v-model="opts.separator" direction="horizontal">
        <van-radio v-for="s in SEPARATORS" :key="s.label" :name="s.value">{{ s.label }}</van-radio>
      </van-radio-group>
    </div>

    <van-cell-group inset class="tool-group">
      <van-cell title="保留非中文字符" label="字母、数字、标点原样输出" center>
        <template #right-icon><van-switch v-model="opts.keepOther" size="22" /></template>
      </van-cell>
      <van-cell title="姓氏模式" label="如“单老师”读 shàn" center>
        <template #right-icon><van-switch v-model="opts.surname" size="22" /></template>
      </van-cell>
    </van-cell-group>

    <van-button type="primary" block :loading="loading" loading-text="正在加载拼音词典…" @click="run">转换</van-button>

    <template v-if="result">
      <div class="tool-result tool-result--text py-out">{{ result.text || '（没有可输出的内容）' }}</div>
      <div v-if="result.hints.length" class="tool-card">
        <h3 class="tool-card__title">多音字提示（当前读音以词语为准）</h3>
        <p v-for="h in result.hints" :key="h.char" class="tool-hint py-hint">
          <b>{{ h.char }}</b>：{{ h.all.join(' / ') }}（当前 {{ h.current }}）
        </p>
      </div>
      <div class="tool-actions">
        <van-button plain :disabled="!result.text" @click="copy">复制结果</van-button>
      </div>
    </template>
  </div>
</template>

<style lang="scss" scoped>
/* 卡片内第二、三组标题与上一组拉开 */
.py-gap {
  margin-top: $space-4;
}
.py-out {
  word-break: break-word;
}
.py-hint {
  line-height: 1.8;
}
</style>
