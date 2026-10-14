<script setup lang="ts">
// 图片提取表格：OCR 文字框 → 行列聚类 → 可编辑表格 → 复制 TSV / 下载 CSV；另有「粘贴文字拆表」入口
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import { showFailToast, showSuccessToast, showToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import { pickImages, saveBlob, type PickedImage } from '@/shared/image-io'
import { aiOcr, AiNotReadyError } from '@/native/ai'
import AiGapNotice from '@/tools/_ai/AiGapNotice.vue'
import { useAiModel } from '@/tools/_ai/useAiModel'
import { aiErrorText, resolveImagePath } from '@/tools/_ai/aiImage'
import { blocksToTable, removeColumn, removeRow, textToTable, toCsv, toTsv, updateCell } from './logic'

/** CSV 文件名 */
const CSV_NAME = 'table.csv'
/** CSV 的 MIME */
const CSV_MIME = 'text/csv;charset=utf-8'

/** 模型状态 */
const { ready, checked, loading: checking, refresh, markNotReady } = useAiModel('ocr')

/** 当前入口：图片识别 / 粘贴文字 */
const tab = ref<'image' | 'text'>('image')
/** 已选图片 */
const image = shallowRef<PickedImage | null>(null)
/** 识别中 */
const busy = ref(false)
/** 粘贴的文字 */
const pasted = ref('')
/** 表格数据 */
const rows = ref<string[][]>([])

/** 列数 */
const colCount = computed(() => (rows.value[0] ? rows.value[0].length : 0))

/** 选图 */
async function choose(): Promise<void> {
  try {
    const got = await pickImages({ onFailed: (f) => showToast(`读取失败：${f[0].message}`) })
    if (!got.length) return
    image.value?.release()
    image.value = got[0]
    rows.value = []
  } catch (e) {
    showToast((e as { message?: string }).message ?? '选图失败')
  }
}

/** 识别图片并聚类成表 */
async function recognize(): Promise<void> {
  if (!image.value || busy.value) return
  busy.value = true
  try {
    const res = await aiOcr(await resolveImagePath(image.value))
    rows.value = blocksToTable(res.blocks)
    if (!rows.value.length) showToast('没有识别到文字')
  } catch (e) {
    if (e instanceof AiNotReadyError) markNotReady()
    else showFailToast(aiErrorText(e))
  } finally {
    busy.value = false
  }
}

/** 把粘贴的文字拆成表 */
function splitText(): void {
  rows.value = textToTable(pasted.value)
  if (!rows.value.length) showToast('没有可拆的内容')
}

/** 编辑单元格 */
function edit(r: number, c: number, ev: Event): void {
  rows.value = updateCell(rows.value, r, c, (ev.target as HTMLInputElement).value)
}

/** 复制为 TSV */
async function copyTsv(): Promise<void> {
  showToast((await copyText(toTsv(rows.value))) ? '已复制，可直接粘贴到 WPS / Excel' : '复制失败，请手动选择')
}

/** 下载 CSV（带 BOM，Excel 打开中文不乱码） */
async function downloadCsv(): Promise<void> {
  try {
    const res = await saveBlob(new Blob([toCsv(rows.value, true)], { type: CSV_MIME }), CSV_NAME)
    showSuccessToast(res.mode === 'native' ? '已保存' : '已下载')
  } catch (e) {
    showFailToast(aiErrorText(e))
  }
}

onBeforeUnmount(() => image.value?.release())
</script>

<template>
  <div class="tool-page">
    <van-tabs v-model:active="tab" type="card">
      <van-tab title="识别图片" name="image" />
      <van-tab title="粘贴文字" name="text" />
    </van-tabs>

    <template v-if="tab === 'image'">
      <div class="tool-card">
        <h3 class="tool-card__title">选择表格图片</h3>
        <img v-if="image" class="preview" :src="image.url" alt="表格图片" />
        <van-button block plain round :disabled="busy" @click="choose">{{ image ? '换一张' : '选择图片' }}</van-button>
        <p class="tool-hint">适合线框清楚、没有合并单元格的表格；效果取决于文字识别质量，识别后可以逐格修改。</p>
      </div>
      <ai-gap-notice v-if="checked && !ready" feature="表格识别" purpose="先识别文字位置，再按行列排成表格" size="约 21MB" retry :loading="checking" @retry="refresh" />
      <van-button type="primary" block round :loading="busy" :disabled="!image || !ready" @click="recognize">
        {{ busy ? '识别中…' : '识别并生成表格' }}
      </van-button>
      <p v-if="checked && !ready" class="tool-hint">模型未就绪时，可以切到「粘贴文字」，把别处识别好的文字拆成表格。</p>
    </template>

    <template v-else>
      <div class="tool-card">
        <h3 class="tool-card__title">粘贴文字</h3>
        <van-field v-model="pasted" type="textarea" rows="6" autosize placeholder="每行一行；列之间用制表符、多个空格或空格隔开" />
        <p class="tool-hint">有制表符按制表符拆；没有则优先按连续多个空格拆（能保留格内单个空格），再不行按任意空白拆。</p>
      </div>
      <van-button type="primary" block round :disabled="!pasted.trim()" @click="splitText">拆成表格</van-button>
    </template>

    <div v-if="rows.length" class="tool-card">
      <h3 class="tool-card__title">表格（{{ rows.length }} 行 × {{ colCount }} 列，可直接修改）</h3>
      <div class="table-wrap">
        <table class="grid">
          <thead>
            <tr>
              <th class="grid__corner" />
              <th v-for="c in colCount" :key="c">
                <button type="button" class="grid__del" :aria-label="`删除第${c}列`" @click="rows = removeColumn(rows, c - 1)">删列</button>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in rows" :key="i">
              <th>
                <button type="button" class="grid__del" :aria-label="`删除第${i + 1}行`" @click="rows = removeRow(rows, i)">删行</button>
              </th>
              <td v-for="(cell, j) in r" :key="j">
                <input class="grid__input" :value="cell" :aria-label="`第${i + 1}行第${j + 1}列`" @change="edit(i, j, $event)" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="actions">
        <van-button type="primary" plain round @click="copyTsv">复制 TSV</van-button>
        <van-button type="primary" plain round @click="downloadCsv">下载 CSV</van-button>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.preview {
  display: block;
  width: 100%;
  max-height: 50vh;
  margin-bottom: $space-3;
  object-fit: contain;
  border-radius: 8px;
}

/* 表格横向可滚动，列多时不撑破页面 */
.table-wrap {
  margin-bottom: $space-3;
  overflow-x: auto;
}

.grid {
  border-collapse: collapse;
  font-size: 14px;

  td,
  th {
    padding: 0;
    border: 1px solid var(--c-border);
  }

  &__corner {
    min-width: 40px;
  }

  &__input {
    display: block;
    box-sizing: border-box;
    min-width: 88px;
    padding: 8px;
    color: var(--c-text);
    background: transparent;
    border: 0;
    outline: none;

    &:focus {
      background: var(--c-surface-active);
    }
  }

  &__del {
    padding: 4px 6px;
    font-size: 12px;
    color: var(--c-text-muted);
    white-space: nowrap;
    background: none;
    border: 0;
  }
}

.actions {
  display: flex;
  gap: $space-3;

  > .van-button {
    flex: 1;
  }
}
</style>
