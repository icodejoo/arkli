<script setup lang="ts">
// 单元格选择器：左标题 + 右当前值 + 箭头，点击弹出 action-sheet 选一项。只管「选一个」，不含页面规则。
import { computed, ref } from 'vue'
import { optionLabel, toActions, type CellOption } from './cellPicker'

/** 选中项高亮色（对应主题主色） */
const ACTIVE_COLOR = 'var(--c-primary)'

/**
 * 属性：
 * - modelValue 当前值（v-model）
 * - options 选项列表
 * - title 单元格标题，同时作为弹层标题
 * - disabled 是否禁用
 *
 * 事件：update:modelValue(value) 选定了一项。
 *
 * @example <cell-picker v-model="size" title="规格" :options="[{ value: 29, label: '29×29' }]" />
 */
const props = defineProps<{ modelValue: string | number; options: readonly CellOption[]; title: string; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: string | number] }>()

/** 弹层是否打开 */
const open = ref(false)
/** 当前值的显示文案 */
const label = computed(() => optionLabel(props.options, props.modelValue))
/** 弹层选项 */
const actions = computed(() => toActions(props.options, props.modelValue, ACTIVE_COLOR))

/** 点击单元格：禁用时不开 */
function show(): void {
  if (!props.disabled) open.value = true
}

/** 选定一项并关闭 */
function onSelect(a: { value: string | number }): void {
  emit('update:modelValue', a.value)
  open.value = false
}
</script>

<template>
  <van-cell :title="title" :value="label" is-link center :class="{ 'is-disabled': disabled }" @click="show" />
  <van-action-sheet v-model:show="open" teleport="body" :title="title" :actions="actions" cancel-text="取消" close-on-click-action @select="onSelect" />
</template>

<style lang="scss" scoped>
.is-disabled {
  opacity: 0.5;
}
</style>
