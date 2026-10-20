<script setup lang="ts">
// 中文转拼音：首次点"转换"才加载拼音词典（体积大），之后改选项自动重算
import BottomActions from '@/shared/BottomActions.vue'
import { ref, watch } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import CellPicker from '@/shared/CellPicker.vue'
import type { CellOption } from '@/shared/cellPicker'
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
const SEPARATORS: CellOption[] = [
  { label: '空格', value: ' ' },
  { label: '无', value: '' },
  { label: '-', value: '-' },
  { label: '_', value: '_' },
]
/** 声调写法选项 */
const TONE_OPTIONS: CellOption[] = [
  { value: 'mark', label: '带声调' },
  { value: 'num', label: '数字声调' },
  { value: 'none', label: '无声调' },
]
/** 拼音样式选项 */
const PATTERN_OPTIONS: CellOption[] = [
  { value: 'full', label: '全拼' },
  { value: 'first', label: '首字母' },
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
    <tool-group title="中文">
      <van-field v-model="input" type="textarea" rows="3" autosize clearable placeholder="输入要转换的文字，如：你好，世界" :error-message="error" />
    </tool-group>

    <tool-group title="转换选项">
      <cell-picker :model-value="opts.tone" title="声调" :options="TONE_OPTIONS" @update:model-value="opts.tone = $event as PinyinOptions['tone']" />
      <cell-picker :model-value="opts.pattern" title="样式" :options="PATTERN_OPTIONS" @update:model-value="opts.pattern = $event as PinyinOptions['pattern']" />
      <cell-picker v-model="opts.separator" title="分隔符" :options="SEPARATORS" />
    </tool-group>

    <tool-group>
      <van-cell title="保留非中文字符" label="字母、数字、标点原样输出" center>
        <template #right-icon><van-switch v-model="opts.keepOther" size="22" /></template>
      </van-cell>
      <van-cell title="姓氏模式" label="如“单老师”读 shàn" center>
        <template #right-icon><van-switch v-model="opts.surname" size="22" /></template>
      </van-cell>
    </tool-group>

    <template v-if="result">
      <div class="tool-result tool-result--text py-out">{{ result.text || '（没有可输出的内容）' }}</div>
      <tool-group v-if="result.hints.length" title="多音字提示（当前读音以词语为准）">
        <p v-for="h in result.hints" :key="h.char" class="tool-hint py-hint">
          <b>{{ h.char }}</b>：{{ h.all.join(' / ') }}（当前 {{ h.current }}）
        </p>
      </tool-group>
    </template>

    <!-- 底部动作栏：复制结果，主按钮转换（首次要加载拼音词典） -->
    <bottom-actions :actions="{ copy: { disabled: !result?.text, text: '复制结果' } }" main :main-text="loading ? '加载词典中' : '转换'" :disabled="{ main: loading }" @main="run" @copy="copy" />
  </div>
</template>

<style lang="scss" scoped>
.py-out {
  word-break: break-word;
}
.py-hint {
  line-height: 1.8;
}
</style>
