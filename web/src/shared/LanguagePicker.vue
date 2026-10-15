<script setup lang="ts">
// 语言选择器：触发器（默认插槽，可覆盖）+ 底部弹层 picker。只负责选一个语言，不管两侧互斥等页面规则。
import { computed, ref } from 'vue'
import { buildColumns, LANGS, langName, type Lang } from './languages'

/**
 * 属性：
 * - modelValue 当前语言码（v-model）
 * - languages 可选语言目录，默认全球目录
 * - supported 'all' 或支持的语言码数组；不支持的置灰并排在后面
 * - title 弹层标题
 *
 * 事件：update:modelValue(code) 选定了一个被支持的语言。
 * 插槽：default，作用域 { langName 当前语言名, code 当前码, show 打开弹层函数 }；缺省渲染「语言名 + 下拉箭头」按钮。
 *
 * @example <language-picker v-model="lang" :supported="['en','fr']" title="源语言" />
 */
const props = withDefaults(
  defineProps<{
    modelValue: string
    languages?: readonly Lang[]
    supported?: 'all' | readonly string[]
    title?: string
  }>(),
  { languages: () => LANGS, supported: 'all', title: '选择语言' },
)
const emit = defineEmits<{ 'update:modelValue': [code: string] }>()

/** 弹层是否打开 */
const open = ref(false)
/** 当前语言展示名 */
const name = computed(() => langName(props.modelValue, props.languages))
/** 支持的语言码集合 */
const supportedCodes = computed(() => (props.supported === 'all' ? props.languages.map((l) => l.code) : props.supported))
/** picker 列：支持的在前，不支持的置灰在后 */
const columns = computed(() => buildColumns(supportedCodes.value, props.languages))

/** 打开弹层 */
function show(): void {
  open.value = true
}

/** 确认选择：置灰（不支持）的语言直接拒绝 */
function onConfirm(e: { selectedValues: Array<string | number> }): void {
  const code = String(e.selectedValues[0])
  if (!supportedCodes.value.includes(code)) return
  emit('update:modelValue', code)
  open.value = false
}

defineExpose({ show })
</script>

<template>
  <slot :lang-name="name" :code="modelValue" :show="show">
    <button type="button" class="lp-trigger" :aria-label="`${title}：${name}`" @click="show">
      <span class="lp-trigger__name">{{ name }}</span>
      <van-icon name="arrow-down" />
    </button>
  </slot>
  <van-popup v-model:show="open" position="bottom" round>
    <van-picker :title="title" :columns="columns" :model-value="[modelValue]" @confirm="onConfirm" @cancel="open = false" />
  </van-popup>
</template>

<style lang="scss" scoped>
// 默认触发器：无修饰的文字按钮
.lp-trigger {
  display: inline-flex;
  align-items: center;
  gap: $space-2;
  min-height: 36px;
  padding: 0;
  font-size: 13px;
  color: var(--c-primary);
  background: none;
  border: 0;
}

.lp-trigger__name {
  font-weight: 600;
}
</style>
