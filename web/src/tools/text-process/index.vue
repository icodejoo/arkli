<script setup lang="ts">
// 文字处理：正则提取、查找替换、行处理、大小写、全半角、统计，另带打开/保存文本文件。
// 保存：目前只做浏览器下载（Blob + <a download>）；宿主内的保存（写入文档目录）先不做，
// 因为 saveBlob 面向图片、会存进相册，不适合纯文本。
import BottomActions from '@/shared/BottomActions.vue'
import { computed, onBeforeUnmount, ref } from 'vue'
import { showToast } from 'vant'
import { createToolStorage } from '@/shared/toolStorage'
import { usePersistedRef } from '@/shared/usePersistedRef'
import { copyText } from '@/shared/clipboard'
import { isNativeAvailable } from '@/native/bridge'
import { share } from '@/native/system'
import { writeBlobToCache } from '@/shared/image-io'
import { pickFile } from '@/shared/file-pick'
import {
  changeCase,
  dedupeLines,
  findReplace,
  MAX_OPEN_CHARS,
  regexExtract,
  shareFileName,
  removeEmptyLines,
  sortLines,
  textStats,
  toFullWidth,
  toHalfWidth,
  trimLines,
  truncateText,
  type CaseMode,
} from './logic'

/** 本工具的持久缓存 */
const store = createToolStorage('text-process')
/** 保存时的默认文件名 */
const DEFAULT_FILE_NAME = 'text.txt'
/** 提取结果最多展示的条数，避免渲染卡顿 */
const MAX_SHOW = 500

/** 编辑区文本 */
const text = ref('')
/** 当前打开的文件名 */
const fileName = ref(DEFAULT_FILE_NAME)
/** 是否只读（大文件被截断后只读） */
const readonly = ref(false)
/** 正则提取：表达式 */
const extractPattern = ref('')
/** 正则提取：区分大小写 */
const extractCase = usePersistedRef(store, 'extractCase', false, (v) => typeof v === 'boolean')
/** 正则提取：去重 */
const extractUnique = usePersistedRef(store, 'extractUnique', false, (v) => typeof v === 'boolean')
/** 提取结果 */
const extracted = ref<string[]>([])
/** 查找内容 */
const findText = ref('')
/** 替换内容 */
const replaceText = ref('')
/** 查找替换：按正则 */
const useRegex = usePersistedRef(store, 'useRegex', false, (v) => typeof v === 'boolean')
/** 查找替换：区分大小写 */
const replaceCase = usePersistedRef(store, 'replaceCase', false, (v) => typeof v === 'boolean')
/** App 内系统文档选择器只列这些类型：文本类（txt/md/csv/log 等）和 JSON */
const OPEN_MIME = 'text/*,application/json'
/** 无宿主时文件选择框接受的类型 */
const OPEN_ACCEPT = 'text/*,.txt,.md,.csv,.json,.log'
/** 保存用的临时 URL，销毁时回收 */
let objectUrl = ''

/** 实时统计 */
const stats = computed(() => textStats(text.value))
/** 提取结果的展示部分 */
const shownExtract = computed(() => extracted.value.slice(0, MAX_SHOW))

/** 复制到剪贴板并提示 */
async function copy(s: string): Promise<void> {
  showToast((await copyText(s)) ? '已复制' : '复制失败，请手动长按选择')
}

/** 执行文本变换，只读时拒绝 */
function apply(fn: (s: string) => string): void {
  if (readonly.value) {
    showToast('大文件只读，不能修改')
    return
  }
  text.value = fn(text.value)
}

/** 大小写转换 */
function doCase(mode: CaseMode): void {
  apply((s) => changeCase(s, mode))
}

/** 执行正则提取，表达式非法时提示 */
function doExtract(): void {
  try {
    extracted.value = regexExtract(text.value, extractPattern.value, {
      caseSensitive: extractCase.value,
      unique: extractUnique.value,
    })
    if (!extractPattern.value) showToast('先写个正则')
    else if (!extracted.value.length) showToast('没有匹配')
  } catch {
    extracted.value = []
    showToast('正则写得不对')
  }
}

/** 执行查找替换 */
function doReplace(): void {
  if (readonly.value) {
    showToast('大文件只读，不能修改')
    return
  }
  try {
    const r = findReplace(text.value, findText.value, replaceText.value, {
      regex: useRegex.value,
      caseSensitive: replaceCase.value,
    })
    text.value = r.text
    showToast(r.count ? `替换了 ${r.count} 处` : '没找到')
  } catch {
    showToast('正则写得不对')
  }
}

/** 点「打开」：选一个文本文件读进编辑区，超过 2MB 只取前 2MB 并转只读 */
async function openFile(): Promise<void> {
  try {
    const file = await pickFile({ mime: OPEN_MIME, accept: OPEN_ACCEPT, onFailed: (f) => showToast(f[0]?.message || '读取失败') })
    if (!file) return
    // 只读前 2MB 多一点，避免把大文件整个读进内存
    const raw = await (file.size > MAX_OPEN_CHARS * 4 ? file.slice(0, MAX_OPEN_CHARS * 4) : file).text()
    const r = truncateText(raw, MAX_OPEN_CHARS)
    text.value = r.text
    fileName.value = file.name
    readonly.value = r.truncated
    extracted.value = []
    if (r.truncated) showToast('文件超过 2MB，只显示前 2MB，已转只读')
  } catch {
    showToast('读取失败')
  }
}

/** 保存为 txt：浏览器下载 */
function save(): void {
  if (objectUrl) URL.revokeObjectURL(objectUrl)
  objectUrl = URL.createObjectURL(new Blob([text.value], { type: 'text/plain;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = fileName.value || DEFAULT_FILE_NAME
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

/** 是否在 App 内（只有宿主能写缓存、拉起分享） */
const hasHost = isNativeAvailable()

/** 分享：先把文本写进原生缓存再交给系统分享面板 */
async function shareText(): Promise<void> {
  try {
    const blob = new Blob([text.value], { type: 'text/plain;charset=utf-8' })
    const path = await writeBlobToCache(blob, shareFileName(fileName.value))
    if (!(await share({ path, mime: 'text/plain' }))) showToast('没有能接收的应用')
  } catch {
    showToast('分享失败')
  }
}

/** 解除只读，改为可编辑（内容仍是截断后的） */
function unlock(): void {
  readonly.value = false
}

onBeforeUnmount(() => {
  if (objectUrl) URL.revokeObjectURL(objectUrl)
})
</script>

<template>
  <div class="tool-page">
    <tool-group>
      <van-field
        v-model="text"
        type="textarea"
        rows="8"
        autosize
        clearable
        clear-trigger="always"
        :readonly="readonly"
        placeholder="在这里输入，或打开一个文本文件"
      />
      <p v-if="readonly" class="tool-hint">
        文件超过 2MB，只显示前 2MB，目前只读。
        <a href="javascript:;" @click="unlock">仍要编辑</a>
      </p>
      <p class="tool-hint">
        {{ stats.chars }} 字（不含空白 {{ stats.charsNoSpace }}）· {{ stats.lines }} 行 · {{ stats.bytes }} 字节
      </p>
    </tool-group>

    <tool-group title="整理">
      <div class="tp-grid">
        <van-button size="small" @click="apply(dedupeLines)">行去重</van-button>
        <van-button size="small" @click="apply((s) => sortLines(s))">升序</van-button>
        <van-button size="small" @click="apply((s) => sortLines(s, true))">降序</van-button>
        <van-button size="small" @click="apply(removeEmptyLines)">去空行</van-button>
        <van-button size="small" @click="apply(trimLines)">去首尾空白</van-button>
        <van-button size="small" @click="doCase('upper')">大写</van-button>
        <van-button size="small" @click="doCase('lower')">小写</van-button>
        <van-button size="small" @click="doCase('title')">首字母大写</van-button>
        <van-button size="small" @click="apply(toHalfWidth)">转半角</van-button>
        <van-button size="small" @click="apply(toFullWidth)">转全角</van-button>
      </div>
    </tool-group>

    <tool-group title="查找替换">
      <van-field v-model="findText" label="查找" placeholder="要找的内容" clearable />
      <van-field v-model="replaceText" label="替换为" placeholder="留空表示删除" clearable />
      <van-cell-group :border="false">
        <van-cell title="正则" center>
          <template #right-icon><van-switch v-model="useRegex" size="20" /></template>
        </van-cell>
        <van-cell title="区分大小写" center>
          <template #right-icon><van-switch v-model="replaceCase" size="20" /></template>
        </van-cell>
      </van-cell-group>
      <div>
        <van-button type="primary" block round size="small" @click="doReplace">全部替换</van-button>
      </div>
    </tool-group>

    <!-- 正则提取只在「查找替换」里开了正则时出现 -->
    <tool-group v-if="useRegex" title="正则提取">
      <van-field v-model="extractPattern" label="表达式" placeholder="如 \d+ 或 [\w.]+@\w+\.com" clearable />
      <van-cell-group :border="false">
        <van-cell title="区分大小写" center>
          <template #right-icon><van-switch v-model="extractCase" size="20" /></template>
        </van-cell>
        <van-cell title="去重" center>
          <template #right-icon><van-switch v-model="extractUnique" size="20" /></template>
        </van-cell>
      </van-cell-group>
      <div>
        <van-button type="primary" block round size="small" @click="doExtract">提取</van-button>
      </div>
      <template v-if="extracted.length">
        <p class="tool-hint">
          共 {{ extracted.length }} 条<template v-if="extracted.length > MAX_SHOW">，只显示前 {{ MAX_SHOW }} 条</template>
        </p>
        <pre class="tp-result">{{ shownExtract.join('\n') }}</pre>
        <div>
          <van-button size="small" plain block @click="copy(extracted.join('\n'))">复制提取结果</van-button>
        </div>
      </template>
    </tool-group>

    <!-- 底部动作栏：打开、保存、分享（仅 App 内）为图标项，主按钮取收尾最常用的「复制」；清空用输入框自带的清除图标 -->
    <bottom-actions
      :actions="{ import: { text: '打开' }, save: { disabled: !text }, share: hasHost && { disabled: !text } }"
      main
      main-text="复制"
      :disabled="{ main: !text }"
      @import="openFile"
      @save="save"
      @share="shareText"
      @main="copy(text)"
    />
  </div>
</template>

<style lang="scss" scoped>
/* 整理按钮网格 */
.tp-grid {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;
}

/* 提取结果 */
.tp-result {
  max-height: 240px;
  margin: $space-2 0;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 14px;
  color: var(--c-text);
}
</style>
