<script setup lang="ts">
/**
 * 模型可调参数面板：根据原生下发的参数规格（spec）动态渲染调整控件。
 * 仅在 AI 中心使用。
 */
import { computed, ref, watch } from 'vue'
import { showToast } from 'vant'
import { useAiParamsStore } from '@/stores/aiParams'
import type { AiParamSpec } from '@/native/ai'
import ModelParamRow from './ModelParamRow.vue'
import {
  ADVANCED_COLLAPSE_TITLE,
  PAGE_OVERRIDE_HINT,
  RESET_ALL_TEXT,
  RESET_FAILED_MSG,
  SET_FAILED_MSG,
  LOAD_FAILED_MSG,
  splitSpecs,
} from './modelParams'

/** 组件接收的属性 */
const props = defineProps<{
  /** 提供者唯一标识 */
  providerId: string
  /** 可选面板标题，用于一个模型对应多个提供者时的区分展示 */
  title?: string
}>()

/** AI 参数 store */
const store = useAiParamsStore()

/** 本地临时维护的参数值，避免滑块拖拽中高频发起请求 */
const localValues = ref<Record<string, number>>({})

/** 高级折叠面板展开项 */
const activeCollapse = ref<string[]>([])

/** 当前提供者的服务端参数状态 */
const state = computed(() => store.get(props.providerId))

/** 全部参数规格列表 */
const specs = computed(() => state.value?.specs ?? [])

/** 拆分出的基础参数与高级参数 */
const splitted = computed(() => splitSpecs(specs.value))
/** 基础参数列表 */
const basicSpecs = computed(() => splitted.value.basic)
/** 高级参数列表 */
const advancedSpecs = computed(() => splitted.value.advanced)

/** 监听服务端参数值变化，同步到本地显示 */
watch(
  () => state.value?.values,
  (vals) => {
    if (vals) localValues.value = { ...vals }
  },
  { immediate: true },
)

/** 监听 providerId 变更，重新加载参数定义与值 */
watch(
  () => props.providerId,
  (id) => {
    if (id) store.load(id).catch(() => showToast(LOAD_FAILED_MSG))
  },
  { immediate: true },
)

/**
 * 提交单个参数的改动，失败时回滚到服务端原值并提示。
 *
 * @param spec 参数规格
 * @param value 新数值
 */
async function onCommit(spec: AiParamSpec, value: number): Promise<void> {
  localValues.value[spec.key] = value
  try {
    await store.set(props.providerId, { [spec.key]: value })
  } catch {
    showToast(SET_FAILED_MSG)
    localValues.value[spec.key] = state.value?.values[spec.key] ?? spec.default
  }
}

/**
 * 单项参数恢复默认值。
 *
 * @param spec 参数规格
 */
async function onResetItem(spec: AiParamSpec): Promise<void> {
  try {
    await store.reset(props.providerId, [spec.key])
  } catch {
    showToast(RESET_FAILED_MSG)
    localValues.value[spec.key] = state.value?.values[spec.key] ?? spec.default
  }
}

/**
 * 恢复当前提供者的所有参数为默认值。
 */
async function onResetAll(): Promise<void> {
  try {
    await store.reset(props.providerId)
  } catch {
    showToast(RESET_FAILED_MSG)
    if (state.value?.values) localValues.value = { ...state.value.values }
  }
}
</script>

<template>
  <div v-if="specs.length > 0" class="mpp">
    <h4 v-if="title" class="mpp__title">{{ title }}</h4>
    <p class="mpp__tip">{{ PAGE_OVERRIDE_HINT }}</p>

    <!-- 基础参数区 -->
    <div class="mpp__group">
      <model-param-row
        v-for="spec in basicSpecs"
        :key="spec.key"
        v-model="localValues[spec.key]"
        :spec="spec"
        @commit="onCommit(spec, $event)"
        @reset="onResetItem(spec)"
      />
    </div>

    <!-- 高级参数折叠区 -->
    <van-collapse v-if="advancedSpecs.length > 0" v-model="activeCollapse" class="mpp__collapse">
      <van-collapse-item :title="ADVANCED_COLLAPSE_TITLE" name="advanced">
        <model-param-row
          v-for="spec in advancedSpecs"
          :key="spec.key"
          v-model="localValues[spec.key]"
          :spec="spec"
          @commit="onCommit(spec, $event)"
          @reset="onResetItem(spec)"
        />
      </van-collapse-item>
    </van-collapse>

    <!-- 底部整组恢复默认按钮 -->
    <div class="mpp__footer">
      <van-button block size="small" plain @click="onResetAll">
        {{ RESET_ALL_TEXT }}
      </van-button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.mpp {
  padding: $space-3 0;
  border-top: 1px solid var(--c-border);

  &__title {
    margin: 0 0 $space-2;
    font-size: 14px;
    font-weight: 600;
    color: var(--c-text);
  }

  &__tip {
    margin: 0 0 $space-3;
    font-size: 12px;
    color: var(--c-text-muted);
  }

  &__group {
    display: flex;
    flex-direction: column;
    gap: $space-3;
  }

  &__collapse {
    margin-top: $space-2;
    margin-bottom: $space-2;
    // 折叠标题与上下参数行左右对齐，去掉 van-cell 自带的内边距
    :deep(.van-collapse-item__title) {
      padding-left: 0;
      padding-right: 0;

      &::after {
        left: 0;
        right: 0;
      }
    }
    :deep(.van-collapse-item__content) {
      padding: $space-2 0;
      display: flex;
      flex-direction: column;
      gap: $space-3;
    }
  }

  &__footer {
    margin-top: $space-3;
  }
}
</style>
