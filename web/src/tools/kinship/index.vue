<script setup lang="ts">
// 亲戚关系计算器：点按钮拼出关系链，显示对应称呼
import { computed, ref } from 'vue'
import { MAX_CHAIN, STEP_LABEL, STEP_ORDER, calcKinship, type Gender, type Step } from './logic'

/** 我的性别 */
const me = ref<Gender>('m')
/** 当前关系链 */
const chain = ref<Step[]>([])

/** 计算结果；链为空时为 null */
const result = computed(() => (chain.value.length ? calcKinship(chain.value, me.value) : null))

/** 关系链是否已达上限 */
const full = computed(() => chain.value.length >= MAX_CHAIN)

/**
 * 追加一步，达到上限后忽略。
 *
 * @param s 步骤
 */
function add(s: Step): void {
  if (chain.value.length < MAX_CHAIN) chain.value.push(s)
}

/** 删掉最后一步 */
function undo(): void {
  chain.value.pop()
}

/** 清空关系链 */
function clear(): void {
  chain.value = []
}
</script>

<template>
  <div class="tool-page">
    <div class="tool-card">
      <van-field label="我是">
        <template #input>
          <van-radio-group v-model="me" direction="horizontal">
            <van-radio name="m">男</van-radio>
            <van-radio name="f">女</van-radio>
          </van-radio-group>
        </template>
      </van-field>
    </div>

    <div class="tool-card">
      <p class="tool-card__title">关系链（最多 {{ MAX_CHAIN }} 步）</p>
      <div class="chain">
        <van-tag type="primary" plain size="large">我</van-tag>
        <template v-for="(s, i) in chain" :key="i">
          <van-icon name="arrow" class="arrow" />
          <van-tag type="primary" size="large">{{ STEP_LABEL[s] }}</van-tag>
        </template>
      </div>
      <p v-if="!chain.length" class="tool-hint gap">点下面的按钮，一步步拼出关系，如「爸爸 → 哥哥 → 儿子」。</p>
    </div>

    <div v-if="result" class="tool-result" :class="{ 'tool-result--error': !result.ok }">
      <template v-if="!result.ok">{{ result.error }}</template>
      <template v-else>
        <span class="tool-result__label">我应该叫 TA</span>
        {{ result.titles.join(' / ') }}
        <span v-if="result.titles.length > 1" class="tool-result__label sub">有多个称呼，要看对方的年龄或具体情况。</span>
      </template>
    </div>

    <div class="tool-card">
      <div class="grid">
        <van-button v-for="s in STEP_ORDER" :key="s" plain type="primary" size="small" :disabled="full" @click="add(s)">
          {{ STEP_LABEL[s] }}
        </van-button>
      </div>
    </div>

    <div class="tool-actions">
      <van-button icon="revoke" :disabled="!chain.length" @click="undo">回退</van-button>
      <van-button icon="delete-o" :disabled="!chain.length" @click="clear">清空</van-button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
// 关系链：标签与箭头横向自动换行
.chain {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

// 链条箭头
.arrow {
  color: var(--c-text-muted);
}

// 提示与链条间距
.gap {
  margin-top: 8px;
}

// 结果补充说明与大字拉开距离
.sub {
  margin: 4px 0 0;
}

// 步骤按钮：5 列网格，触控区足够大
.grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 8px;

  .van-button {
    height: 40px;
    padding: 0;
  }
}
</style>
