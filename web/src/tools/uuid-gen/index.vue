<script setup lang="ts">
// UUID / 随机 ID 生成：v4、v7、NanoID，批量生成并一键复制
import { computed, ref } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import { createToolStorage } from '@/shared/toolStorage'
import { usePersistedRef } from '@/shared/usePersistedRef'
import {
  BATCH_MAX,
  generateIds,
  ID_KINDS,
  NANOID_DEFAULT_ALPHABET,
  NANOID_DEFAULT_SIZE,
  NANOID_SIZE_MAX,
  NANOID_SIZE_MIN,
  validateOptions,
  type IdKind,
} from './logic'

/** 本工具的持久缓存 */
const store = createToolStorage('uuid-gen')
/** 默认批量数量 */
const DEFAULT_COUNT = 5

/** 当前类型 */
const kind = usePersistedRef<IdKind>(store, 'kind', 'uuid4', (v) => ID_KINDS.some((k) => k.id === v))
/** 数量 */
const count = ref(DEFAULT_COUNT)
/** NanoID 长度 */
const size = ref(NANOID_DEFAULT_SIZE)
/** NanoID 字符集 */
const alphabet = ref(NANOID_DEFAULT_ALPHABET)
/** 大写（仅 UUID） */
const upper = usePersistedRef(store, 'upper', false, (v) => typeof v === 'boolean')
/** 去连字符（仅 UUID） */
const noDash = usePersistedRef(store, 'noDash', false, (v) => typeof v === 'boolean')
/** 生成结果 */
const list = ref<string[]>([])

/** 当前选项 */
const opts = computed(() => ({
  kind: kind.value,
  count: Number(count.value),
  size: Number(size.value),
  alphabet: alphabet.value,
  upper: upper.value,
  noDash: noDash.value,
}))
/** 选项错误提示 */
const error = computed(() => validateOptions(opts.value))

/** 生成一批 */
function generate(): void {
  if (error.value) return
  list.value = generateIds(opts.value)
}
generate()

/** 复制文本并提示 */
async function copy(text: string): Promise<void> {
  if (await copyText(text)) showSuccessToast('已复制')
  else showFailToast('复制失败，请长按文字手动选择')
}
</script>

<template>
  <div class="tool-page">
    <van-tabs v-model:active="kind" type="card" @change="generate">
      <van-tab v-for="k in ID_KINDS" :key="k.id" :title="k.label" :name="k.id" />
    </van-tabs>

    <tool-group title="选项">
      <van-field v-model="count" type="digit" :label="`数量（1~${BATCH_MAX}）`" label-width="9em" />
      <template v-if="kind === 'nanoid'">
        <van-field v-model="size" type="digit" :label="`长度（${NANOID_SIZE_MIN}~${NANOID_SIZE_MAX}）`" label-width="9em" />
        <van-field v-model="alphabet" label="字符集" label-width="9em" clearable />
      </template>
      <template v-else>
        <van-cell title="大写字母" center>
          <template #right-icon><van-switch v-model="upper" size="22" /></template>
        </van-cell>
        <van-cell title="去掉连字符" center>
          <template #right-icon><van-switch v-model="noDash" size="22" /></template>
        </van-cell>
      </template>
      <p v-if="error" class="tool-hint uuid-error">{{ error }}</p>
      <p v-if="kind === 'uuid7'" class="tool-hint">v7 前 48 位是毫秒时间戳，按生成时间可排序，适合做数据库主键。</p>
    </tool-group>

    <van-button type="primary" block :disabled="!!error" @click="generate">重新生成</van-button>

    <tool-group v-if="list.length" title="结果（点一行复制）">
      <div v-for="(id, i) in list" :key="i + id" class="uuid-row" @click="copy(id)">{{ id }}</div>
      <van-button size="small" plain class="uuid-copy-all" @click="copy(list.join('\n'))">复制全部</van-button>
    </tool-group>
  </div>
</template>

<style lang="scss" scoped>
.uuid-error {
  color: var(--c-error);
}
.uuid-row {
  padding: $space-2 0;
  border-bottom: 1px solid var(--c-border);
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 13px;
  word-break: break-all;
  cursor: pointer;
}
.uuid-copy-all {
  margin-top: $space-3;
}
</style>
