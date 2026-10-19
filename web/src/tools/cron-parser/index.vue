<script setup lang="ts">
// Cron 表达式：中文说明 + 接下来 5 次触发时间（本地时区）
import { computed, ref } from 'vue'
import { describeCron, formatRun, nextRuns, parseCron } from './logic'

/** 常用示例 */
const EXAMPLES = ['*/5 * * * *', '0 8 * * *', '30 9 * * 1-5', '0 0 1 * *', '0 */2 * * *']

/** 表达式输入 */
const input = ref('*/5 * * * *')
/** 解析结果，空输入为 null */
const parsed = computed(() => (input.value.trim() ? parseCron(input.value) : null))
/** 中文说明 */
const desc = computed(() => (parsed.value?.ok ? describeCron(parsed.value.expr) : ''))
/** 接下来的触发时间 */
const runs = computed(() => (parsed.value?.ok ? nextRuns(parsed.value.expr, new Date()).map(formatRun) : []))
</script>

<template>
  <div class="tool-page">
    <tool-group title="表达式（分 时 日 月 周）">
      <van-field v-model="input" clearable placeholder="如 */5 9-18 * * 1-5" />
      <div class="cron-examples">
        <van-tag v-for="e in EXAMPLES" :key="e" plain type="primary" size="medium" @click="input = e">{{ e }}</van-tag>
      </div>
      <p class="tool-hint">支持 * , - / 四种符号；周 0 或 7 都是周日；日和周都限定时，任一满足就触发。</p>
    </tool-group>

    <p v-if="parsed && !parsed.ok" class="tool-hint cron-error">{{ parsed.error }}</p>

    <template v-if="parsed && parsed.ok">
      <tool-group title="含义">
        <p class="cron-desc">{{ desc }}</p>
      </tool-group>
      <tool-group title="接下来 5 次触发">
        <van-cell v-for="(r, i) in runs" :key="r" :title="`第 ${i + 1} 次`" :value="r" />
        <p v-if="!runs.length" class="tool-hint">未来 9 年内不会触发（日期组合可能不存在）。</p>
      </tool-group>
    </template>
  </div>
</template>

<style lang="scss" scoped>
.cron-examples {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;
  margin-top: $space-2;
}
.cron-error {
  color: var(--c-error);
}
.cron-desc {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}
</style>
