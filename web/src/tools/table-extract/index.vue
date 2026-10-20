<script setup lang="ts">
// 图片提取表格：OCR 文字框 → 行列聚类 → 可编辑表格 → 复制 TSV / 下载 CSV；另有「粘贴文字拆表」入口
import BottomActions from '@/shared/BottomActions.vue'
import ModelPicker from '@/shared/ModelPicker.vue'
import { computed, onBeforeUnmount, onDeactivated, ref, shallowRef } from 'vue'
import { showFailToast, showSuccessToast, showToast } from 'vant'
import { copyText } from '@/shared/clipboard'
import { EDIT_BASIC, pickImages, saveBlob, type PickedImage } from '@/shared/image-io'
import { shootPhoto } from '@/shared/shootPhoto'
import { aiOcr, AiNotReadyError } from '@/native/ai'
import { useAiCatalog } from '@/native/useAiCatalog'
import ModelMissingNotice from '@/shared/ModelMissingNotice.vue'
import { aiErrorText, handleNotReady, resolveImagePath } from '@/tools/_ai/aiImage'
import { isAiCancelled } from '@/native/ai'
import { blocksToTable, removeColumn, removeRow, textToTable, toCsv, toTsv, updateCell } from './logic'

/** CSV 文件名 */
const CSV_NAME = 'table.csv'
/** CSV 的 MIME */
const CSV_MIME = 'text/csv;charset=utf-8'

/** 本工具 id（与 registry 一致） */
const TOOL_ID = 'table-extract'
/** 本工具的 AI 目录（用文字识别任务）：模型状态只读，下载、删除、校验都在 AI 中心 */
const catalog = useAiCatalog(TOOL_ID)
/** 提供者是否已探测过；探测前不提示“无可用模型”，免得闪一下 */
const catalogReady = catalog.ready
/** 所选文字识别模型是否已安装 */
const modelReady = computed(() => catalog.current.value?.status === 'ready')
/** 当前识别的取消控制器 */
let controller: AbortController | null = null

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

/** 采用新图：释放旧图并清掉旧表格 */
function adopt(img: PickedImage): void {
  image.value?.release()
  image.value = img
  rows.value = []
}

/** 相册选图 */
async function choose(): Promise<void> {
  try {
    const got = await pickImages({ edit: EDIT_BASIC, onFailed: (f) => showToast(`读取失败：${f[0].message}`) })
    if (got.length) adopt(got[0])
  } catch (e) {
    showToast((e as { message?: string }).message ?? '选图失败')
  }
}

/** 拍照 */
async function shoot(): Promise<void> {
  const got = await shootPhoto()
  if (got) adopt(got)
}

/** 底部主按钮：图片页识别，粘贴页拆表 */
function onMain(): void {
  if (tab.value === 'image') void recognize()
  else splitText()
}

/** 识别图片并聚类成表 */
async function recognize(): Promise<void> {
  if (!image.value || busy.value) return
  busy.value = true
  controller = new AbortController()
  try {
    const res = await aiOcr(await resolveImagePath(image.value), controller.signal)
    rows.value = blocksToTable(res.blocks)
    if (!rows.value.length) showToast('没有识别到文字')
  } catch (e) {
    if (isAiCancelled(e)) return
    // 撞上“模型未就绪”：重新探测目录，提示条随之出现；状态仍显示可用时给一句通用提示
    if (e instanceof AiNotReadyError) await handleNotReady(catalog.refresh, () => catalog.current.value?.status === 'ready', showFailToast)
    else showFailToast(aiErrorText(e))
  } finally {
    controller = null
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

/** 离开页面：取消还在跑的识别，释放图片 */
function cleanup(): void {
  controller?.abort()
  image.value?.release()
}

onDeactivated(() => controller?.abort())
onBeforeUnmount(cleanup)
</script>

<template>
  <div class="tool-page">
    <van-tabs v-model:active="tab" type="card">
      <van-tab title="识别图片" name="image" />
      <van-tab title="粘贴文字" name="text" />
    </van-tabs>

    <template v-if="tab === 'image'">
      <tool-group title="选择表格图片">
        <img v-if="image" class="preview" :src="image.url" alt="表格图片" />
        <p v-else class="tool-hint">点底部「相册」或「拍照」选一张表格图片。</p>
        <p class="tool-hint">适合线框清楚、没有合并单元格的表格；效果取决于文字识别质量，识别后可以逐格修改。</p>
      </tool-group>
      <model-missing-notice v-if="catalogReady && !modelReady" />
      <p v-if="catalogReady && !modelReady" class="tool-hint">模型未就绪时，可以切到「粘贴文字」，把别处识别好的文字拆成表格。</p>
    </template>

    <template v-else>
      <tool-group title="粘贴文字">
        <van-field v-model="pasted" type="textarea" rows="6" autosize placeholder="每行一行；列之间用制表符、多个空格或空格隔开" />
        <p class="tool-hint">有制表符按制表符拆；没有则优先按连续多个空格拆（能保留格内单个空格），再不行按任意空白拆。</p>
      </tool-group>
    </template>

    <tool-group v-if="rows.length" :title="`表格（${rows.length} 行 × ${colCount} 列，可直接修改）`">
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
    </tool-group>

    <!-- 底部动作栏：图片页有相册 / 拍照，复制 TSV、下载 CSV，主按钮识别或拆表 -->
    <bottom-actions ai
      :album="tab === 'image'"
      :photo="tab === 'image'"
      main
      :main-text="tab === 'image' ? (busy ? '识别中' : '识别') : '拆成表格'"
      :disabled="{ album: busy, photo: busy, main: tab === 'image' ? busy || !image || !modelReady : !pasted.trim() }"
      @album="choose"
      @photo="shoot"
      @main="onMain"
      :actions="{ copy: { disabled: !rows.length }, save: { disabled: !rows.length, text: 'CSV' } }"
      @copy="copyTsv"
      @save="downloadCsv"
    >
      <template #ai><model-picker :tool-id="TOOL_ID" variant="bar" /></template>
    </bottom-actions>
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
</style>
