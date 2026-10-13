<script setup lang="ts">
// 单位换算：选类别、输入数值，下方一次列出该类全部单位的结果，点哪行就以哪个单位为输入
import { computed, ref } from 'vue'
import { CATEGORIES, convert, formatNumber, parseNumber } from './logic'

/** 当前类别 id */
const catId = ref(CATEGORIES[0].id)
/** 当前输入单位 id */
const fromId = ref(CATEGORIES[0].units[0].id)
/** 输入文本 */
const text = ref('1')

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
    <van-tabs :active="catId" type="card" shrink @click-tab="({ name }) => pickCat(name)">
      <van-tab v-for="c in CATEGORIES" :key="c.id" :name="c.id" :title="c.name" />
    </van-tabs>

    <div class="tool-card">
      <van-field
        v-model="text"
        label="数值"
        type="text"
        inputmode="decimal"
        placeholder="输入数值"
        autocomplete="off"
        clearable
        :error-message="errorMsg"
      />
      <p v-if="cat.note && !errorMsg" class="tool-hint note">{{ cat.note }}</p>
    </div>

    <van-cell-group class="tool-group">
      <van-cell
        v-for="r in rows"
        :key="r.id"
        :title="r.name"
        :value="r.id === fromId ? '输入单位' : r.text"
        :class="{ 'is-from': r.id === fromId }"
        is-link
        @click="fromId = r.id"
      />
    </van-cell-group>
    <p class="tool-hint">点任意一行，改以该单位作为输入。</p>
  </div>
</template>

<style lang="scss" scoped>
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
