<script setup lang="ts">
// 快递单号识别：本地规则判断可能的快递公司，复制单号后跳官网查询（不联网查轨迹）
import BottomActions from '@/shared/BottomActions.vue'
import { computed, onMounted, ref } from 'vue'
import { showFailToast, showSuccessToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import { createToolStorage } from '@/shared/toolStorage'
import type { Carrier } from './data'
import { CONFIDENCE_LABEL, identify, pushHistory } from './logic'

/** 旧 localStorage 键（迁移用） */
const LEGACY_HISTORY_KEY = 'arkli:express-track:history'
/** 最近查询的缓存键 */
const HISTORY_KEY = 'history'
/** 持久缓存 */
const store = createToolStorage('express-track')

/** 输入的单号 */
const input = ref('')
/** 是否已点过识别（避免一打开就显示"请输入"错误） */
const touched = ref(false)
/** 最近查询 */
const history = ref<string[]>([])

/** 识别结果 */
const result = computed(() => identify(input.value))

/** 读最近查询，坏数据忽略（并迁移旧键） */
function loadHistory(): void {
  store.adoptLegacy(LEGACY_HISTORY_KEY, HISTORY_KEY)
  const v = store.get<unknown>(HISTORY_KEY, [])
  history.value = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** 记下这个单号 */
function remember(no: string): void {
  history.value = pushHistory(history.value, no)
  store.set(HISTORY_KEY, history.value)
}

/** 点"识别"：有合法单号就记下来 */
function run(): void {
  touched.value = true
  if (!result.value.error) remember(result.value.no)
}

/** 用最近查询里的单号填回输入框 */
function useHistory(no: string): void {
  input.value = no
  touched.value = true
}

/** 复制单号 */
async function copyNo(): Promise<void> {
  const ok = await copyText(result.value.no)
  if (ok) showSuccessToast('已复制')
  else showFailToast('复制失败')
}

/** 复制单号并打开官网（在 App 里会交给外部浏览器） */
async function openOfficial(c: Carrier): Promise<void> {
  await copyText(result.value.no)
  window.open(c.url, '_blank')
}
</script>

<template>
  <div class="tool-page">
    <tool-group>
      <van-field v-model="input" label="单号" placeholder="粘贴或输入快递单号" clearable @keyup.enter="run" />
    </tool-group>

    <tool-group v-if="history.length" title="最近查过">
      <div class="ex-history">
        <van-tag v-for="h in history" :key="h" size="large" plain @click="useHistory(h)">{{ h }}</van-tag>
      </div>
    </tool-group>

    <template v-if="touched">
      <div v-if="result.error" class="tool-result tool-result--error">{{ result.error }}</div>
      <template v-else>
        <tool-group title="可能的快递公司">
          <p v-if="!result.candidates.length" class="tool-hint">
            没有认出来。可能是小众快递或新号段，换个单号试试，或直接到快递公司官网查。
          </p>
          <van-cell-group v-else :border="false">
            <van-cell
              v-for="c in result.candidates"
              :key="c.carrier.id"
              :title="c.carrier.name"
              :label="`${CONFIDENCE_LABEL[c.confidence]} · ${c.note}`"
              center
            >
              <template #right-icon>
                <van-button size="small" plain type="primary" @click="openOfficial(c.carrier)">官方查询</van-button>
              </template>
            </van-cell>
          </van-cell-group>
        </tool-group>
        <p class="tool-hint">
          点「官方查询」会先复制单号，再用外部浏览器打开官网首页，到查询框粘贴即可。纯数字单号容易撞号，结果只是推测。
        </p>
      </template>
    </template>

    <!-- 底部动作栏：复制单号，主按钮识别快递公司 -->
    <bottom-actions :actions="{ copy: { disabled: !touched || !!result.error, text: '复制单号' } }" main main-text="识别" @main="run" @copy="copyNo" />
  </div>
</template>

<style lang="scss" scoped>
/* 最近查询标签区 */
.ex-history {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;
}
</style>
