<script setup lang="ts">
// 垃圾分类查询：本地词典检索，按上海四分类显示色块与投放提示
import { computed, ref } from 'vue'
import { CATS, WASTE_ITEMS } from './data'
import { countByCat, getCat, search } from './logic'

/** 搜索框内容 */
const query = ref('')
/** 免责声明 */
const DISCLAIMER = '按上海「可回收物 / 有害垃圾 / 湿垃圾 / 干垃圾」四分类整理，仅供参考，以当地最新规定为准。'

/** 检索结果 */
const hits = computed(() => search(query.value))
/** 是否输入了内容 */
const typed = computed(() => query.value.trim() !== '')
/** 各类条数，用于图例 */
const counts = computed(() => countByCat())
</script>

<template>
  <div class="tool-page">
    <div class="tool-card">
      <van-field v-model="query" label="物品" placeholder="输入物品名，如 电池、奶茶杯" clearable />
    </div>

    <template v-if="typed">
      <div v-if="!hits.length" class="tool-card">
        <p class="tool-hint">词典里没找到「{{ query.trim() }}」。换个叫法试试；实在分不清，一般投干垃圾，药品电池之类的先问问物业。</p>
      </div>
      <ul v-else class="ws-list">
        <li v-for="h in hits" :key="h.item.name" class="ws-item">
          <span class="ws-badge" :style="{ background: getCat(h.item.cat)?.color, color: getCat(h.item.cat)?.textColor }">
            {{ getCat(h.item.cat)?.name }}
          </span>
          <div class="ws-body">
            <strong>{{ h.item.name }}</strong>
            <span v-if="h.matchedAlias" class="tool-hint">（也叫 {{ h.matchedAlias }}）</span>
            <p class="tool-hint ws-tip">{{ h.item.tip || getCat(h.item.cat)?.tip }}</p>
          </div>
        </li>
      </ul>
    </template>

    <div v-else class="tool-card">
      <h3 class="tool-card__title">四种垃圾怎么投（共 {{ WASTE_ITEMS.length }} 条物品）</h3>
      <ul class="ws-legend">
        <li v-for="c in CATS" :key="c.id">
          <span class="ws-badge" :style="{ background: c.color, color: c.textColor }">{{ c.name }}</span>
          <span class="tool-hint">{{ counts[c.id] }} 条 · {{ c.tip }}</span>
        </li>
      </ul>
    </div>

    <p class="tool-hint">{{ DISCLAIMER }}</p>
  </div>
</template>

<style lang="scss" scoped>
/* 结果列表 */
.ws-list {
  display: flex;
  flex-direction: column;
  gap: $space-2;
  margin: 0;
  padding: 0;
  list-style: none;
}

/* 一条结果 */
.ws-item {
  display: flex;
  align-items: flex-start;
  gap: $space-3;
  padding: $space-3;
  background: var(--c-surface);
  border-radius: var(--tool-card-radius);
}

/* 分类色块：固定宽度，保证各行对齐 */
.ws-badge {
  flex: none;
  min-width: 68px;
  padding: 4px 8px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  text-align: center;
}

/* 文字区 */
.ws-body {
  min-width: 0;
  color: var(--c-text);
}

/* 投放提示 */
.ws-tip {
  margin-top: 2px;
}

/* 图例 */
.ws-legend {
  display: flex;
  flex-direction: column;
  gap: $space-3;
  margin: 0;
  padding: 0;
  list-style: none;

  li {
    display: flex;
    align-items: flex-start;
    gap: $space-3;
  }
}
</style>
