<script setup lang="ts">
// 模型选择器的列表：只负责按状态渲染与抛出点击，逻辑在 modelPicker.ts
import type { PickerItem } from './modelPicker'

/** 描述里「未下载」的警示文案，用危险色 */
const MISSING_TEXT = '未下载'
/** 描述末尾的下载提示，用主题色强调 */
const DL_HINT = '点击下载'
/** 描述里「已安装」的文案，用成功色 */
const INSTALLED_TEXT = '已安装'

/**
 * 把描述拆成「前缀 / 状态词 / 后缀」，状态词单独着色。
 *
 * @param desc 描述全文
 * @param word 状态词
 * @returns 拆分结果；未命中返回 null
 */
function splitWord(desc: string, word: string): [string, string] | null {
  const i = desc.indexOf(word)
  return i < 0 ? null : [desc.slice(0, i), desc.slice(i + word.length)]
}

/** 要渲染的行 */
defineProps<{ items: PickerItem[] }>()
/** 点击某行 */
defineEmits<{ pick: [item: PickerItem] }>()
</script>

<template>
  <ul class="mp__list">
    <li
      v-for="it in items"
      :key="it.id"
      :class="['mp__item', `mp__item--${it.status}`]"
      :data-status="it.status"
      @click="$emit('pick', it)"
    >
      <div class="mp__text">
        <div class="mp__title">{{ it.title }}</div>
        <div class="mp__desc">
          <template v-if="it.status === 'missing' && splitWord(it.desc, MISSING_TEXT)">
            {{ splitWord(it.desc, MISSING_TEXT)![0] }}<span class="mp__bad">{{ MISSING_TEXT }}</span>{{
              splitWord(it.desc, MISSING_TEXT)![1].replace(DL_HINT, '')
            }}<span class="mp__hint">{{ DL_HINT }}</span>
          </template>
          <template v-else-if="(it.status === 'ready' || it.status === 'selected') && splitWord(it.desc, INSTALLED_TEXT)">
            {{ splitWord(it.desc, INSTALLED_TEXT)![0] }}<span class="mp__ok">{{ INSTALLED_TEXT }}</span>{{
              splitWord(it.desc, INSTALLED_TEXT)![1]
            }}
          </template>
          <template v-else>{{ it.desc }}</template>
        </div>
      </div>
      <span v-if="it.status === 'loading'" class="mp__spin" role="progressbar" />
      <span v-else-if="it.status === 'selected'" class="mp__check">✓</span>
    </li>
  </ul>
</template>

<style lang="scss" scoped>
.mp {
  &__list {
    margin: 0;
    padding: $space-2 0;
    list-style: none;
  }

  &__item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: $space-3 $space-4;
    color: var(--c-text);

    // 未接入：整行置灰（不用 disabled，点击仍要响应）
    &--unsupported {
      color: var(--c-text-muted);
      opacity: 0.6;
    }
  }

  // 「未下载」文案：危险色
  &__bad {
    color: var(--c-error);
  }

  // 「已安装」文案：成功色
  &__ok {
    color: var(--c-ok);
  }

  // 「点击下载」提示：主题色
  &__hint {
    color: var(--c-primary);
  }

  // 下载中的转圈（不引 Vant，便于单测）
  &__spin {
    width: 16px;
    height: 16px;
    border: 2px solid var(--c-text-muted);
    border-top-color: var(--c-primary);
    border-radius: 50%;
    animation: mp-spin 0.8s linear infinite;
  }

  &__check {
    font-size: 16px;
    color: var(--c-ok);
  }

  &__title {
    font-size: 15px;
  }

  &__desc {
    margin-top: 2px;
    font-size: 12px;
    color: var(--c-text-muted);
  }
}

@keyframes mp-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
