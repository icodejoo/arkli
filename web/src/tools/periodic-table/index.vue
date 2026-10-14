<script setup lang="ts">
// 元素周期表：18 列网格（竖屏可横向滚动）+ 搜索 + 点击看详情
import { computed, ref } from 'vue'
import { CATEGORY_LABELS, ELEMENTS, type Category, type Element } from './data'
import {
  ACTINIDE_ROW,
  electronConfig,
  formatMass,
  gridPos,
  groupOf,
  isRadioactive,
  LANTHANIDE_ROW,
  periodOf,
  searchElements,
} from './logic'

/** 搜索关键字 */
const keyword = ref('')
/** 详情弹窗是否显示 */
const showDetail = ref(false)
/** 当前查看的元素 */
const current = ref<Element | null>(null)

/** 搜索命中的原子序数集合；没有搜索词时为 null（全部显示） */
const hitSet = computed<Set<number> | null>(() => {
  if (!keyword.value.trim()) return null
  return new Set(searchElements(keyword.value).map((e) => e.z))
})
/** 命中数量 */
const hitCount = computed(() => hitSet.value?.size ?? ELEMENTS.length)

/** 所有分类，用来画图例 */
const categories = Object.keys(CATEGORY_LABELS) as Category[]

/** 元素格的行列样式 */
function cellStyle(e: Element): Record<string, string> {
  const p = gridPos(e.z)!
  return { gridRow: String(p.row), gridColumn: String(p.col) }
}

/** 点击元素打开详情 */
function open(e: Element): void {
  current.value = e
  showDetail.value = true
}

/** 当前元素的详情文本 */
const detail = computed(() => {
  const e = current.value
  if (!e) return null
  const g = groupOf(e.z)
  return {
    group: g ? `第 ${g} 族` : e.category === 'lanthanide' ? '镧系（f 区）' : '锕系（f 区）',
    period: `第 ${periodOf(e.z)} 周期`,
    mass: formatMass(e),
    config: electronConfig(e.z),
    radio: isRadioactive(e.z),
    predicted: e.z >= 104,
  }
})
</script>

<template>
  <div class="tool-page">
    <div class="tool-card">
      <van-field v-model="keyword" clearable placeholder="搜序号、符号、中文或英文名" />
      <p v-if="keyword.trim()" class="tool-hint pt-hint">命中 {{ hitCount }} 个，高亮显示</p>
    </div>

    <div class="tool-card pt-wrap">
      <div class="pt-grid">
        <button
          v-for="e in ELEMENTS"
          :key="e.z"
          type="button"
          class="pt-cell"
          :class="[`pt-cell--${e.category}`, { 'pt-cell--dim': hitSet && !hitSet.has(e.z) }]"
          :style="cellStyle(e)"
          @click="open(e)"
        >
          <span class="pt-cell__z">{{ e.z }}</span>
          <span class="pt-cell__sym">{{ e.symbol }}</span>
          <span class="pt-cell__cn">{{ e.z < 104 ? e.cn : '' }}</span>
        </button>
        <!-- f 区占位提示 -->
        <div class="pt-mark" style="grid-row: 6; grid-column: 3">57-71</div>
        <div class="pt-mark" style="grid-row: 7; grid-column: 3">89-103</div>
        <div class="pt-mark" :style="{ gridRow: String(LANTHANIDE_ROW), gridColumn: '1 / 3' }">镧系</div>
        <div class="pt-mark" :style="{ gridRow: String(ACTINIDE_ROW), gridColumn: '1 / 3' }">锕系</div>
      </div>
    </div>

    <div class="tool-card">
      <h3 class="tool-card__title">图例</h3>
      <div class="pt-legend">
        <span v-for="c in categories" :key="c" class="pt-legend__item">
          <i class="pt-legend__dot" :class="`pt-cell--${c}`" />{{ CATEGORY_LABELS[c] }}
        </span>
      </div>
      <p class="tool-hint pt-hint">原子质量带方括号的是质量数（没有标准原子量）。104 号以后的元素性质多为理论预测。</p>
    </div>

    <van-popup v-model:show="showDetail" round position="bottom" closeable>
      <div v-if="current && detail" class="pt-detail">
        <div class="pt-detail__head">
          <span class="pt-detail__sym" :class="`pt-cell--${current.category}`">{{ current.symbol }}</span>
          <div>
            <div class="pt-detail__name">
              {{ current.cn }}<small v-if="current.read">（读 {{ current.read }}）</small>
            </div>
            <div class="tool-hint">{{ current.en }} · {{ CATEGORY_LABELS[current.category] }}</div>
          </div>
        </div>
        <van-cell title="原子序数" :value="String(current.z)" />
        <van-cell title="相对原子质量" :value="detail.mass" />
        <van-cell title="周期 / 族" :value="`${detail.period} · ${detail.group}`" />
        <van-cell title="电子排布" :value="detail.config" />
        <p v-if="detail.radio" class="tool-hint">放射性元素。</p>
        <p v-if="detail.predicted" class="tool-hint">电子排布与分类为理论预测值。</p>
      </div>
    </van-popup>
  </div>
</template>

<style lang="scss" scoped>
.pt-hint {
  margin-top: $space-2;
}

/* 网格容器横向滚动，手机竖屏看全表 */
.pt-wrap {
  padding: $space-2;
  overflow-x: auto;
}
/* 18 列 × 每格 38px；第 8 行是主表与 f 区之间的空隙 */
.pt-grid {
  display: grid;
  grid-template-columns: repeat(18, 38px);
  grid-template-rows: repeat(7, 46px) 10px repeat(2, 46px);
  gap: 2px;
  width: max-content;
}

.pt-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 0;
  color: #1c1c1e;
  border: 0;
  border-radius: 4px;
  line-height: 1.1;
  cursor: pointer;

  &--dim {
    opacity: 0.18;
  }
  &__z {
    font-size: 8px;
  }
  &__sym {
    font-size: 14px;
    font-weight: 600;
  }
  &__cn {
    font-size: 8px;
  }
}

/* 分类配色：浅色底配深字，深浅主题下都够清楚 */
.pt-cell--alkali { background: #ffb4a8; }
.pt-cell--alkaline { background: #ffd29a; }
.pt-cell--transition { background: #ffe58f; }
.pt-cell--post-transition { background: #c3e6a1; }
.pt-cell--metalloid { background: #9fe3d0; }
.pt-cell--nonmetal { background: #a8d4ff; }
.pt-cell--halogen { background: #c5b8ff; }
.pt-cell--noble { background: #f2b3e6; }
.pt-cell--lanthanide { background: #b8e0e8; }
.pt-cell--actinide { background: #e3c9b0; }

.pt-mark {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  color: var(--c-text-muted);
  border: 1px dashed var(--c-border);
  border-radius: 4px;
}

.pt-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  font-size: 12px;
}
.pt-legend__item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.pt-legend__dot {
  width: 12px;
  height: 12px;
  border-radius: 3px;
}

.pt-detail {
  padding: $space-4;
  padding-top: 40px;
}
.pt-detail__head {
  display: flex;
  align-items: center;
  gap: $space-3;
  margin-bottom: $space-2;
}
.pt-detail__sym {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  color: #1c1c1e;
  font-size: 24px;
  font-weight: 700;
  border-radius: 10px;
}
.pt-detail__name {
  font-size: 20px;
  font-weight: 600;

  small {
    margin-left: 4px;
    font-size: 12px;
    font-weight: 400;
    color: var(--c-text-muted);
  }
}
</style>
