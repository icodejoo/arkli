<script setup lang="ts">
// 成语查询：内置精选词库，支持成语/拼音/首字母/释义搜索，详情里可接龙
import BottomActions from '@/shared/BottomActions.vue'
import { computed, ref } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import { builtinSource, chainNext, MAX_RESULTS, randomIdiom, searchIdioms, type Idiom } from './logic'

/** 数据源：日后换成下载数据包时，只需在这里换实现 */
const source = builtinSource
/** 全部成语（只读一次） */
const all: Idiom[] = source.all()

/** 搜索关键字 */
const keyword = ref('')
/** 当前打开详情的成语，null 表示未打开 */
const current = ref<Idiom | null>(null)
/** 详情弹窗显隐 */
const show = ref(false)

/** 搜索结果 */
const hits = computed(() => searchIdioms(all, keyword.value))
/** 当前成语的接龙候选 */
const chain = computed(() => (current.value ? chainNext(all, current.value) : []))

/** 打开某个成语的详情 */
function open(idiom: Idiom): void {
  current.value = idiom
  show.value = true
}

/** 随机来一个并打开详情 */
function pickRandom(): void {
  const idiom = randomIdiom(all)
  if (idiom) open(idiom)
}

/** 复制“成语 拼音：释义” */
async function copy(): Promise<void> {
  const i = current.value
  if (!i) return
  const text = `${i.word}（${i.pinyin}）：${i.meaning}`
  if (await copyText(text)) showSuccessToast('已复制')
  else showFailToast('复制失败，请长按文字手动选择')
}
</script>

<template>
  <div class="tool-page">
    <tool-group title="查成语">
      <van-search v-model="keyword" shape="round" placeholder="成语、拼音、首字母（如 yxzx）或释义关键字" :clearable="true" />
      <p class="tool-hint">内置精选词库（{{ all.length }} 条），非完整词典。</p>
    </tool-group>

    <tool-group v-if="hits.length">
      <van-cell v-for="h in hits" :key="h.idiom.word" :title="h.idiom.word" :label="h.idiom.pinyin" is-link @click="open(h.idiom)" />
    </tool-group>
    <p v-if="hits.length >= MAX_RESULTS" class="tool-hint idiom-more">最多显示 {{ MAX_RESULTS }} 条，换个关键字再缩小范围。</p>
    <p v-else-if="keyword.trim() && !hits.length" class="tool-hint idiom-more">词库里没找到，换个说法试试。</p>

    <!-- 底部动作栏：主按钮随机来一个（详情弹层层级更高，会盖住这条栏） -->
    <bottom-actions main main-text="随机来一个" @main="pickRandom" />

    <van-popup v-model:show="show" position="bottom" round closeable :style="{ maxHeight: '80%' }">
      <div v-if="current" class="idiom-detail">
        <h2 class="idiom-word">{{ current.word }}</h2>
        <p class="idiom-pinyin">{{ current.pinyin }}</p>
        <p class="idiom-meaning">{{ current.meaning }}</p>
        <p v-if="current.example" class="tool-hint">例：{{ current.example }}</p>
        <van-button plain size="small" @click="copy">复制</van-button>

        <h3 class="tool-group__title idiom-chain-title">接龙：以“{{ Array.from(current.word).pop() }}”开头</h3>
        <p v-if="!chain.length" class="tool-hint">词库里暂时没有可接的。</p>
        <div v-else class="idiom-chain">
          <van-tag v-for="c in chain" :key="c.idiom.word" size="large" :type="c.diffSound ? 'warning' : 'primary'" plain @click="open(c.idiom)">
            {{ c.idiom.word }}<template v-if="c.diffSound">（读 {{ c.idiom.pinyin.split(' ')[0] }}）</template>
          </van-tag>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<style lang="scss" scoped>
.idiom-more {
  text-align: center;
}
.idiom-detail {
  padding: $space-4;
  padding-top: 40px;
  overflow-y: auto;
}
.idiom-word {
  margin: 0;
  font-size: 28px;
}
.idiom-pinyin {
  margin: 4px 0 12px;
  color: var(--van-gray-6);
}
.idiom-meaning {
  line-height: 1.7;
}
.idiom-chain-title {
  margin-top: $space-4;
}
.idiom-chain {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
