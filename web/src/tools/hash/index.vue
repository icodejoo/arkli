<script setup lang="ts">
// 哈希计算：文本实时算，或选文件分块算；MD5 / SHA-1 / SHA-256 / SHA-512 一起出
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import { createToolStorage } from '@/shared/toolStorage'
import { usePersistedRef } from '@/shared/usePersistedRef'
import { clipboardWrite } from '@/native/system'
import { BIG_FILE_BYTES, copyWithFallback, formatHex, HASH_ALGOS, hashFile, hashText, matchExpected, type HashDigests } from './logic'

/** 防抖毫秒数 */
const DEBOUNCE_MS = 150
/** 一兆字节，用来显示文件大小 */
const MB = 1024 * 1024

/** 持久缓存 */
const store = createToolStorage('hash')

/** 数据来源：文本 / 文件 */
const source = usePersistedRef<'text' | 'file'>(store, 'source', 'text', (v) => v === 'text' || v === 'file')
/** 文本输入 */
const input = ref('')
/** 防抖后的文本 */
const settled = ref('')
/** 大写 hex */
const upper = usePersistedRef(store, 'upper', false, (v) => typeof v === 'boolean')
/** 期望值（用来比对） */
const expected = ref('')
/** 已选文件 */
const file = ref<File | null>(null)
/** 文件计算结果 */
const fileDigests = ref<HashDigests | null>(null)
/** 文件计算进度 0~1，null 表示没在算 */
const progress = ref<number | null>(null)
/** 取消标记，换文件、切页或点取消时置位 */
let cancelled = false
/** 防抖定时器 */
let debounce: ReturnType<typeof setTimeout> | undefined

/** 当前展示的哈希结果：文本模式空输入也显示空串的哈希 */
const digests = computed<HashDigests | null>(() => (source.value === 'text' ? hashText(settled.value) : fileDigests.value))
/** 与期望值一致的算法 */
const matched = computed(() => (digests.value ? matchExpected(digests.value, expected.value) : null))
/** 是否填了期望值 */
const hasExpected = computed(() => expected.value.trim() !== '')
/** 是大文件，要给耗时提示 */
const isBigFile = computed(() => (file.value?.size ?? 0) >= BIG_FILE_BYTES)

watch(input, (v) => {
  clearTimeout(debounce)
  debounce = setTimeout(() => (settled.value = v), DEBOUNCE_MS)
})
watch(source, () => {
  cancelled = true
})
onBeforeUnmount(() => {
  cancelled = true
  clearTimeout(debounce)
})

/** 选了文件就开算 */
async function onPick(e: Event): Promise<void> {
  const f = (e.target as HTMLInputElement).files?.[0]
  ;(e.target as HTMLInputElement).value = ''
  if (!f) return
  cancelled = true
  file.value = f
  fileDigests.value = null
  progress.value = 0
  await Promise.resolve()
  cancelled = false
  try {
    const res = await hashFile(f, { onProgress: (d, t) => (progress.value = t ? d / t : 1), isCancelled: () => cancelled })
    if (!cancelled && file.value === f) fileDigests.value = res
  } catch {
    showFailToast('读取文件失败')
  } finally {
    if (file.value === f) progress.value = null
  }
}

/** 中止文件计算 */
function cancel(): void {
  cancelled = true
  progress.value = null
}

/** 复制某一项 */
async function copy(hex: string): Promise<void> {
  if (await copyWithFallback(formatHex(hex, upper.value), (t) => clipboardWrite(t, false), copyText)) showSuccessToast('已复制')
  else showFailToast('复制失败，请长按文字手动选择')
}

/** 字节数显示成 MB */
function sizeText(n: number): string {
  return n >= MB ? `${(n / MB).toFixed(1)} MB` : `${n} B`
}
</script>

<template>
  <div class="tool-page">
    <van-tabs v-model:active="source" type="card">
      <van-tab title="文本" name="text" />
      <van-tab title="文件" name="file" />
    </van-tabs>

    <tool-group v-if="source === 'text'" title="文本（按 UTF-8 计算）">
      <van-field v-model="input" type="textarea" rows="3" autosize clearable placeholder="输入要计算哈希的文本" />
    </tool-group>

    <tool-group v-else title="文件">
      <label class="hash-pick">
        <input type="file" class="hash-pick__input" @change="onPick" />
        <span class="hash-pick__btn">{{ file ? '换一个文件' : '选择文件' }}</span>
      </label>
      <p v-if="file" class="tool-hint hash-file">{{ file.name }}（{{ sizeText(file.size) }}）</p>
      <p v-if="isBigFile" class="tool-hint">文件较大，计算需要一会儿，请保持页面打开。</p>
      <van-progress v-if="progress !== null" :percentage="Math.round(progress * 100)" stroke-width="6" class="hash-progress" />
      <van-button v-if="progress !== null" size="small" plain @click="cancel">取消</van-button>
      <p v-if="!file" class="tool-hint">文件只在本机读取，不会上传。</p>
    </tool-group>

    <tool-group>
      <van-cell title="大写字母" center>
        <template #right-icon><van-switch v-model="upper" size="22" /></template>
      </van-cell>
    </tool-group>

    <tool-group v-if="digests" title="结果（点一行复制）">
      <div
        v-for="a in HASH_ALGOS"
        :key="a.id"
        class="hash-row"
        :class="{ 'hash-row--ok': matched === a.id }"
        @click="copy(digests[a.id])"
      >
        <span class="hash-row__name">{{ a.label }}<van-icon v-if="matched === a.id" name="success" /></span>
        <code class="hash-row__hex">{{ formatHex(digests[a.id], upper) }}</code>
      </div>
    </tool-group>

    <tool-group title="比对期望值（可选）">
      <van-field v-model="expected" clearable placeholder="粘贴官方给出的哈希值" />
      <p v-if="hasExpected && digests" class="tool-hint hash-verdict" :class="{ 'hash-verdict--ok': matched }">
        {{ matched ? '一致，匹配 ' + HASH_ALGOS.find((a) => a.id === matched)?.label : '不一致' }}
      </p>
    </tool-group>
  </div>
</template>

<style lang="scss" scoped>
/* 原生文件框藏起来，用按钮样式的 label 代替 */
.hash-pick {
  display: inline-block;
  cursor: pointer;
}
.hash-pick__input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
}
.hash-pick__btn {
  display: inline-block;
  padding: 8px 16px;
  color: #fff;
  background: var(--c-primary);
  border-radius: 8px;
  font-size: 14px;
}
.hash-file {
  margin-top: $space-2;
  word-break: break-all;
}
.hash-progress {
  margin: $space-2 0;
}

/* 结果一行：名称在上，hex 在下，整行可点复制 */
.hash-row {
  padding: $space-2 0;
  border-bottom: 1px solid var(--c-border);
  cursor: pointer;

  &:last-child {
    border-bottom: 0;
  }

  &--ok .hash-row__name {
    color: var(--van-success-color);
  }
}
.hash-row__name {
  display: block;
  margin-bottom: 2px;
  font-size: 12px;
  color: var(--c-text-muted);
}
.hash-row__hex {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 13px;
  line-height: 1.5;
  color: var(--c-text);
  word-break: break-all;
}

.hash-verdict {
  margin-top: $space-2;
  color: var(--c-error);

  &--ok {
    color: var(--van-success-color);
  }
}
</style>
