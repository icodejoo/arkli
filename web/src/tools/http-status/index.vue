<script setup lang="ts">
// HTTP 状态码查询：按码或关键字搜，按 1xx~5xx 分类折叠，每条给含义与常见场景
import { computed, ref, watch } from 'vue'
import { CLASS_LABELS } from './data'
import { groupByClass, searchStatus } from './logic'

/** 搜索关键字 */
const keyword = ref('')
/** 展开的分类折叠面板（名称为大类编号字符串） */
const openClasses = ref<string[]>([])
/** 展开的单条状态码 */
const openCodes = ref<string[]>([])

/** 搜索结果按大类分组 */
const groups = computed(() => groupByClass(searchStatus(keyword.value)))
/** 命中总数 */
const total = computed(() => groups.value.reduce((n, g) => n + g.items.length, 0))

// 有搜索词时自动展开所有命中的分类，清空后恢复收起
watch(keyword, (v) => {
  openClasses.value = v.trim() ? groups.value.map((g) => String(g.cls)) : []
})
</script>

<template>
  <div class="tool-page">
    <tool-group>
      <van-field v-model="keyword" clearable placeholder="输入状态码（如 404、40）或关键字（如 超时）" />
      <p v-if="keyword.trim()" class="tool-hint hs-count">共 {{ total }} 条</p>
    </tool-group>

    <p v-if="!groups.length" class="tool-hint">没有找到匹配的状态码。</p>

    <van-collapse v-else v-model="openClasses">
      <van-collapse-item v-for="g in groups" :key="g.cls" :name="String(g.cls)" :title="CLASS_LABELS[g.cls]" :value="`${g.items.length} 条`">
        <van-collapse v-model="openCodes" :border="false">
          <van-collapse-item v-for="s in g.items" :key="s.code" :name="String(s.code)">
            <template #title>
              <b class="hs-code">{{ s.code }}</b>
              {{ s.name }}
              <van-tag v-if="s.nonStandard" plain type="warning" class="hs-tag">非标准</van-tag>
            </template>
            <p class="hs-phrase">{{ s.phrase }}</p>
            <p class="hs-row"><b>含义</b>{{ s.meaning }}</p>
            <p class="hs-row"><b>场景</b>{{ s.scene }}</p>
          </van-collapse-item>
        </van-collapse>
      </van-collapse-item>
    </van-collapse>
  </div>
</template>

<style lang="scss" scoped>
.hs-count {
  margin-top: $space-2;
}
.hs-code {
  display: inline-block;
  min-width: 36px;
  margin-right: 4px;
  font-family: ui-monospace, Menlo, Consolas, monospace;
}
.hs-tag {
  margin-left: 6px;
}
.hs-phrase {
  margin: 0 0 $space-2;
  font-size: 12px;
  color: var(--c-text-muted);
}
.hs-row {
  margin: 0 0 6px;
  line-height: 1.6;

  b {
    margin-right: 8px;
    color: var(--c-text-muted);
    font-weight: 500;
  }
}
</style>
