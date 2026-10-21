<script setup lang="ts">
// 单位换算：选类别、输入数值，下方一次列出该类全部单位的结果，点哪行就以哪个单位为输入
import { computed, nextTick, onMounted, ref } from 'vue'
import CellPicker from '@/shared/CellPicker.vue'
import { createToolStorage } from '@/shared/toolStorage'
import { usePersistedRef } from '@/shared/usePersistedRef'
import { CATEGORIES, convert, formatNumber, parseNumber } from './logic'

/** 本工具的持久缓存 */
const store = createToolStorage('unit-convert')
/** 当前类别 id（记住上次选的类别） */
const catId = usePersistedRef(store, 'catId', CATEGORIES[0].id, (v) => CATEGORIES.some((c) => c.id === v))
/** 当前输入单位 id（默认取当前类别第一个单位） */
const fromId = ref((CATEGORIES.find((c) => c.id === catId.value) ?? CATEGORIES[0]).units[0].id)
/** 输入文本 */
const text = ref('1')

/** 结果分组标题里的操作说明 */
const RESULT_HINT = '点任意一行，改以该单位作为输入'

/** 类别选项 */
const catOptions = CATEGORIES.map((c) => ({ value: c.id, label: c.name }))

/** 数值输入框实例，进页面后自动聚焦 */
const field = ref<{ focus: () => void } | null>(null)

onMounted(() => {
  void nextTick(() => field.value?.focus())
})

/** 当前类别 */
const cat = computed(() => CATEGORIES.find((c) => c.id === catId.value) ?? CATEGORIES[0])
/** 解析后的数值；非法为 null */
const value = computed(() => parseNumber(text.value))
/** 输入框行内错误 */
const errorMsg = computed(() => (text.value.trim() && value.value === null ? '请输入有效数字' : ''))

/** 各单位的换算结果行 */
const rows = computed(() =>
  cat.value.units.map((x) => ({
    id: x.id,
    name: x.name,
    text: value.value === null ? '' : formatNumber(convert(value.value, fromId.value, x.id)),
  })),
)

/**
 * 切换类别，输入单位重置为该类第一个单位。
 *
 * @param id 类别 id
 */
function pickCat(id: string | number): void {
  catId.value = String(id)
  fromId.value = cat.value.units[0].id
}
</script>

<template>
  <div class="tool-page">
    <tool-group title="换算参数">
      <cell-picker :model-value="catId" title="类别" :options="catOptions" @update:model-value="pickCat" />
      <van-field
        ref="field"
        v-model="text"
        label="数值"
        type="text"
        input-align="right"
        inputmode="decimal"
        placeholder="输入数值"
        autocomplete="off"
        clearable
        :error-message="errorMsg"
      />
      <p v-if="cat.note && !errorMsg" class="tool-hint note">{{ cat.note }}</p>
    </tool-group>

    <tool-group>
      <template #title>
        换算结果<span class="result-hint">（{{ RESULT_HINT }}）</span>
      </template>
      <van-cell
        v-for="r in rows"
        :key="r.id"
        :title="r.name"
        :value="r.id === fromId ? '输入单位' : r.text"
        :class="{ 'is-from': r.id === fromId }"
        is-link
        @click="fromId = r.id"
      />
    </tool-group>
  </div>
</template>

<style lang="scss" scoped>
/* 结果标题里的说明：小号字 + 主题色 */
.result-hint {
  font-size: 12px;
  color: var(--c-primary);
}

// 提示与输入框之间留点距离
.note {
  margin-top: 8px;
}

// 当前输入单位行：高亮主色
.is-from {
  background: var(--c-surface-active);

  :deep(.van-cell__title),
  :deep(.van-cell__value) {
    color: var(--c-primary);
  }
}

// 结果值允许选中
:deep(.van-cell__value) {
  user-select: text;
  word-break: break-all;
}

</style>
