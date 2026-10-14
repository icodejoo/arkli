<script setup lang="ts">
// 查字：输入汉字，看读音（多音字全列）、Unicode 码点、UTF-8 / UTF-16 字节与所在区段
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import { infoToText, loadPinyin, lookupChar, MAX_CHARS, splitChars, type CharInfo, type PinyinLib, type Readings } from './logic'

/** 输入防抖（毫秒），避免每敲一个字就查一遍 */
const DEBOUNCE_MS = 250
/** 读音写法选项 */
const TONE_OPTIONS: ReadonlyArray<{ key: keyof Readings; label: string }> = [
  { key: 'mark', label: '带声调' },
  { key: 'num', label: '数字调' },
  { key: 'none', label: '无调' },
]

/** 输入文本 */
const input = ref('')
/** 读音写法 */
const tone = ref<keyof Readings>('mark')
/** 查询结果 */
const list = ref<CharInfo[]>([])
/** 输入是否超出上限被截断 */
const truncated = ref(false)
/** 词典加载中 */
const loading = ref(false)
/** 词典加载失败 */
const failed = ref(false)
/** 已加载的 pinyin-pro */
let lib: PinyinLib | undefined
/** 防抖定时器 */
let timer: ReturnType<typeof setTimeout> | undefined

/** 当前写法下，某个字的读音文本 */
const readingText = computed(() => (info: CharInfo): string => info.readings[tone.value].join('、'))

/** 执行查询：首次用到时才加载词典 */
async function run(): Promise<void> {
  const { chars, truncated: cut } = splitChars(input.value)
  truncated.value = cut
  if (!chars.length) {
    list.value = []
    return
  }
  if (!lib) {
    loading.value = true
    failed.value = false
    try {
      lib = await loadPinyin()
    } catch {
      failed.value = true
      return
    } finally {
      loading.value = false
    }
  }
  // 等词典期间输入可能又变了，以最新输入为准
  const latest = splitChars(input.value)
  truncated.value = latest.truncated
  list.value = latest.chars.map((c) => lookupChar(lib as PinyinLib, c))
}

/** 复制某个字的全部信息 */
async function copy(info: CharInfo): Promise<void> {
  if (await copyText(infoToText(info))) showSuccessToast('已复制')
  else showFailToast('复制失败，请长按文字手动选择')
}

watch(input, () => {
  clearTimeout(timer)
  timer = setTimeout(() => void run(), DEBOUNCE_MS)
})
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <div class="tool-page">
    <div class="tool-card">
      <van-field v-model="input" type="textarea" rows="2" autosize placeholder="输入一个或多个汉字，如：长、𠮷" />
      <p v-if="truncated" class="tool-hint">一次最多查 {{ MAX_CHARS }} 个不同的字，多的已忽略。</p>
      <van-radio-group v-model="tone" direction="horizontal" class="cl-tone">
        <van-radio v-for="o in TONE_OPTIONS" :key="o.key" :name="o.key">{{ o.label }}</van-radio>
      </van-radio-group>
      <p v-if="loading" class="tool-hint">正在加载拼音词典…</p>
      <p v-if="failed" class="tool-hint">拼音词典加载失败，读音暂时查不了，改改输入再试一次。</p>
    </div>

    <div v-for="info in list" :key="info.char" class="tool-card cl-card">
      <div class="cl-head">
        <span class="cl-char">{{ info.char }}</span>
        <div class="cl-read">
          <template v-if="info.readings[tone].length">{{ readingText(info) }}</template>
          <span v-else class="cl-muted">{{ info.range.han ? '没查到读音' : '不是汉字，没有读音' }}</span>
        </div>
        <van-button size="small" plain @click="copy(info)">复制</van-button>
      </div>
      <van-cell-group :border="false">
        <van-cell title="Unicode" :value="info.unicode" />
        <van-cell title="所在区段" :value="info.range.label" />
        <van-cell title="UTF-8" :value="info.utf8" />
        <van-cell title="UTF-16" :value="info.utf16" />
      </van-cell-group>
      <p v-if="info.range.han && !info.range.basic" class="tool-hint">不在常用的基本区（U+4E00–9FFF），属于扩展区或兼容区，部分字体可能显示成方块。</p>
      <p class="tool-hint cl-gap">部首、笔画、释义需要词典数据包，暂未内置。</p>
    </div>

    <p v-if="!list.length && !loading" class="tool-hint">只查读音与编码，不做简繁转换。</p>
  </div>
</template>

<style lang="scss" scoped>
/* 写法选择与输入框之间留距 */
.cl-tone {
  margin-top: $space-2;
}

/* 头部：大字 + 读音 + 复制按钮 */
.cl-head {
  display: flex;
  align-items: center;
  gap: $space-3;
  margin-bottom: $space-2;
}

/* 大字 */
.cl-char {
  min-width: 56px;
  font-size: 48px;
  line-height: 1.1;
  text-align: center;
  color: var(--c-text);
}

/* 读音区占满剩余宽度，多音字可换行 */
.cl-read {
  flex: 1;
  font-size: 18px;
  word-break: break-all;
  color: var(--c-text);
}

/* 灰色提示文字 */
.cl-muted {
  font-size: 14px;
  color: var(--c-text-muted);
}

/* 缺口提示与上方留距 */
.cl-gap {
  margin-top: $space-2;
}
</style>
