<script setup lang="ts">
// 自定义抽签：输入选项，抽出 N 个；选项自动存本地，下次打开还在
import BottomActions from '@/shared/BottomActions.vue'
import { computed, ref } from 'vue'
import { createToolStorage } from '@/shared/toolStorage'
import { usePersistedRef } from '@/shared/usePersistedRef'
import { parseOptions } from '@/shared/options'
import { checkDraw, drawLots } from './logic'

/** 旧版 localStorage 键（仅用于迁移） */
const LEGACY_KEY = 'arkli:lottery:text'

/** 本工具的持久缓存 */
const store = createToolStorage('lottery')
// 旧版把选项原文直接存在单独键里，一次性迁入（不做 JSON 解析）
store.adoptLegacy(LEGACY_KEY, 'text', (raw) => raw)

/** 选项输入，改动后自动记住（属于已有的自带缓存，保留） */
const text = usePersistedRef(store, 'text', '', (v) => typeof v === 'string')
/** 抽取个数 */
const count = ref(1)
/** 抽签结果 */
const picked = ref<string[]>([])
/** 是否抽过（用于区分“还没抽”和“清空了”） */
const drawn = ref(false)

/** 解析后的选项 */
const parsed = computed(() => parseOptions(text.value))
/** 校验结果：没输入时不报错，只在有输入但不合规时提示 */
const error = computed(() => (text.value.trim() ? checkDraw(parsed.value.items, count.value).error : null))

/** 开抽 */
function go(): void {
  if (checkDraw(parsed.value.items, count.value).error) return
  picked.value = drawLots(parsed.value.items, count.value)
  drawn.value = true
}

/** 清空输入与结果 */
function clear(): void {
  text.value = ''
  picked.value = []
  drawn.value = false
}
</script>

<template>
  <div class="tool-page">
    <tool-group title="选项（每行一个，也可用逗号分隔）">
      <van-field v-model="text" type="textarea" rows="5" autosize placeholder="火锅&#10;烧烤&#10;麻辣烫" />
      <p class="tool-hint lottery-meta">
        共 {{ parsed.items.length }} 个选项
        <template v-if="parsed.duplicates">，已忽略 {{ parsed.duplicates }} 个重复</template>
        <template v-if="parsed.truncated">，超出上限的部分已忽略</template>
      </p>
    </tool-group>

    <tool-group>
      <van-cell-group :border="false">
        <van-cell title="抽取个数" center>
          <template #value>
            <van-stepper v-model="count" :min="1" :max="Math.max(1, parsed.items.length)" integer />
          </template>
        </van-cell>
      </van-cell-group>
      <p v-if="error" class="tool-hint lottery-error" role="alert">{{ error }}</p>
    </tool-group>

    <van-button plain block round @click="clear">清空选项</van-button>

    <tool-group v-if="drawn && picked.length" title="抽中了" class="lottery-result" aria-live="polite">
      <van-cell-group :border="false">
        <van-cell v-for="(p, i) in picked" :key="p" :title="p" center>
          <template #icon><span class="lottery-no">{{ i + 1 }}</span></template>
        </van-cell>
      </van-cell-group>
    </tool-group>

    <!-- 底部动作栏：主按钮抽签 -->
    <bottom-actions main main-text="抽签" :disabled="{ main: !!checkDraw(parsed.items, count).error }" @main="go" />
  </div>
</template>

<style lang="scss" scoped>
/* 选项统计小字 */
.lottery-meta {
  margin-top: $space-2;
}

/* 校验错误：红字提示 */
.lottery-error {
  margin-top: $space-2;
  color: var(--c-error);
}

/* 结果卡片弹出动画 */
.lottery-result {
  animation: pop 0.25s ease-out;
}

/* 序号圆点 */
.lottery-no {
  display: inline-block;
  width: 24px;
  height: 24px;
  margin-right: $space-3;
  border-radius: 50%;
  background: var(--c-primary);
  color: var(--c-on-primary);
  font-size: 13px;
  line-height: 24px;
  text-align: center;
}

@keyframes pop {
  from {
    transform: scale(0.96);
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .lottery-result {
    animation: none;
  }
}
</style>
