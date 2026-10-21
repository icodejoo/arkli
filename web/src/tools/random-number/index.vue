<script setup lang="ts">
// 随机数生成：设范围、个数、是否重复、是否排序、小数位数，一键生成并复制
import BottomActions from '@/shared/BottomActions.vue'
import { ref } from 'vue'
import { showToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import { createToolStorage } from '@/shared/toolStorage'
import { usePersistedRef } from '@/shared/usePersistedRef'
import { inRange, isBool } from '@/shared/persistValidators'
import { generateNumbers, MAX_COUNT, MAX_DECIMALS, STORE_NS } from './logic'

/** 持久缓存 */
const store = createToolStorage(STORE_NS)

/** 下界（用字符串接输入，避免输入中途被转成 0） */
const min = ref('1')
/** 上界 */
const max = ref('100')
/** 个数 */
const count = usePersistedRef(store, 'count', 5, (x) => inRange(x, { min: 1, max: MAX_COUNT }))
/** 小数位数 */
const decimals = usePersistedRef(store, 'decimals', 0, (x) => inRange(x, { min: 0, max: MAX_DECIMALS }))
/** 允许重复 */
const allowDuplicates = usePersistedRef(store, 'allowDuplicates', true, isBool)
/** 排序 */
const sort = usePersistedRef(store, 'sort', false, isBool)
/** 结果 */
const results = ref<string[]>([])
/** 错误提示 */
const error = ref('')

/** 生成：参数问题直接把原因展示出来 */
function generate(): void {
  try {
    results.value = generateNumbers({
      min: Number(min.value),
      max: Number(max.value),
      count: count.value,
      allowDuplicates: allowDuplicates.value,
      sort: sort.value,
      decimals: decimals.value,
    })
    error.value = ''
  } catch (e) {
    results.value = []
    error.value = e instanceof Error ? e.message : '生成失败'
  }
}

/** 复制结果，用空格分隔 */
async function copy(): Promise<void> {
  showToast((await copyText(results.value.join(' '))) ? '已复制' : '复制失败，请手动长按选择')
}
</script>

<template>
  <div class="tool-page">
    <tool-group>
      <van-cell-group :border="false">
        <van-field v-model="min" label="最小值" type="number" />
        <van-field v-model="max" label="最大值" type="number" />
        <van-cell title="个数" center>
          <template #value>
            <van-stepper v-model="count" :min="1" :max="MAX_COUNT" integer />
          </template>
        </van-cell>
        <van-cell title="小数位数" center>
          <template #value>
            <van-stepper v-model="decimals" :min="0" :max="MAX_DECIMALS" integer />
          </template>
        </van-cell>
        <van-cell title="允许重复" center>
          <template #value><van-switch v-model="allowDuplicates" size="22" /></template>
        </van-cell>
        <van-cell title="从小到大排序" center>
          <template #value><van-switch v-model="sort" size="22" /></template>
        </van-cell>
      </van-cell-group>
    </tool-group>

    <tool-group v-if="error" class="rn-error">{{ error }}</tool-group>

    <tool-group v-if="results.length" :title="`结果（${results.length} 个）`">
      <p class="rn-out">{{ results.join('  ') }}</p>
    </tool-group>

    <!-- 底部动作栏：复制结果，主按钮生成 -->
    <bottom-actions :actions="{ copy: { disabled: !results.length } }" main @main="generate" @copy="copy" />
  </div>
</template>

<style lang="scss" scoped>
/* 错误提示 */
.rn-error {
  color: var(--c-error);
}

/* 结果文字 */
.rn-out {
  margin: 0 0 $space-3;
  font-size: 20px;
  line-height: 1.6;
  color: var(--c-text);
  word-break: break-all;
}
</style>
