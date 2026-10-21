<script setup lang="ts">
// Linux 指令手册：搜索命令、按分类筛选，点开看选项与示例，示例可一键复制
import { computed, ref } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import { oneOf } from '@/shared/persistValidators'
import { createToolStorage } from '@/shared/toolStorage'
import { usePersistedRef } from '@/shared/usePersistedRef'
import { CATEGORIES, COMMANDS, type Category } from './data'
import { countByCategory, isDanger, searchCommands } from './logic'

/** 「全部」分类的标记 */
const ALL = ''
/** 本工具的持久缓存 */
const store = createToolStorage('linux-manual')
/** 搜索关键词 */
const query = ref('')
/** 当前分类，空串表示全部 */
const cat = usePersistedRef<Category | typeof ALL>(store, 'cat', ALL, oneOf([ALL, ...CATEGORIES]))
/** 展开中的命令名 */
const opened = ref<string[]>([])

/** 各分类命令数 */
const counts = countByCategory(COMMANDS)
/** 筛选后的结果 */
const list = computed(() => searchCommands(COMMANDS, query.value, cat.value))

/** 复制一条示例命令 */
async function copy(text: string): Promise<void> {
  if (await copyText(text)) showSuccessToast('已复制')
  else showFailToast('复制失败，请手动长按选择')
}
</script>

<template>
  <div class="tool-page">
    <tool-group>
      <van-field v-model="query" placeholder="搜命令名、别名或作用，如 rm、删除" clearable />
      <div class="lm-cats">
        <van-tag :plain="cat !== ALL" type="primary" size="large" class="lm-cat" @click="cat = ALL">全部 {{ COMMANDS.length }}</van-tag>
        <van-tag v-for="k in CATEGORIES" :key="k" :plain="cat !== k" type="primary" size="large" class="lm-cat" @click="cat = k">{{ k }} {{ counts[k] }}</van-tag>
      </div>
    </tool-group>

    <p v-if="!list.length" class="tool-hint">没有匹配的命令，换个关键词试试。</p>

    <van-collapse v-model="opened">
      <van-collapse-item v-for="x in list" :key="x.name" :name="x.name">
        <template #title>
          <span class="lm-name">{{ x.name }}</span>
          <van-tag v-if="isDanger(x)" type="danger" class="lm-danger-tag">危险</van-tag>
          <span class="lm-brief">{{ x.brief }}</span>
        </template>

        <div v-if="x.danger" class="lm-danger"><b>危险：</b>{{ x.danger }}</div>
        <h4 class="lm-h">语法</h4>
        <code class="lm-code">{{ x.syntax }}</code>

        <template v-if="x.options.length">
          <h4 class="lm-h">常用选项</h4>
          <dl class="lm-opts">
            <template v-for="o in x.options" :key="o[0]">
              <dt>{{ o[0] }}</dt>
              <dd>{{ o[1] }}</dd>
            </template>
          </dl>
        </template>

        <h4 class="lm-h">示例（点一下复制）</h4>
        <div v-for="e in x.examples" :key="e[0]" class="lm-ex" @click="copy(e[0])">
          <code class="lm-code">{{ e[0] }}</code>
          <span class="lm-ex__note"># {{ e[1] }}</span>
        </div>

        <p v-if="x.note" class="lm-note">{{ x.note }}</p>
      </van-collapse-item>
    </van-collapse>
  </div>
</template>

<style lang="scss" scoped>
/* 分类标签行 */
.lm-cats {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;
  margin-top: $space-3;
}

.lm-cat {
  cursor: pointer;
}

/* 命令名 */
.lm-name {
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-weight: 700;
}

/* 一句话作用 */
.lm-brief {
  margin-left: $space-2;
  font-size: 13px;
  color: var(--c-text-muted);
}

.lm-danger-tag {
  margin-left: $space-2;
}

/* 危险说明条 */
.lm-danger {
  padding: $space-3;
  margin-bottom: $space-3;
  border-left: 4px solid #ee0a24;
  border-radius: 4px;
  background: rgba(238, 10, 36, 0.1);
  font-size: 13px;
  line-height: 1.6;
}

/* 小标题 */
.lm-h {
  margin: $space-3 0 $space-2;
  font-size: 13px;
  color: var(--c-text-muted);
}

/* 代码块 */
.lm-code {
  display: block;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 13px;
  word-break: break-all;
  white-space: pre-wrap;
}

/* 选项表 */
.lm-opts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: $space-1 $space-3;
  margin: 0;
  font-size: 13px;

  dt {
    font-family: ui-monospace, Menlo, Consolas, monospace;
    font-weight: 600;
  }

  dd {
    margin: 0;
  }
}

/* 单条示例：整行可点 */
.lm-ex {
  padding: $space-2 $space-3;
  margin-bottom: $space-2;
  border-radius: 8px;
  background: var(--c-bg, rgba(127, 127, 127, 0.1));
  cursor: pointer;

  &__note {
    font-size: 12px;
    color: var(--c-text-muted);
  }
}

.lm-note {
  margin: $space-3 0 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--c-text-muted);
}
</style>
