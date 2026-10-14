<script setup lang="ts">
// 极简记账：数据存 IndexedDB，按月看收支与分类占比，可导出 JSON/CSV、导入 JSON
import { computed, onMounted, ref } from 'vue'
import { showConfirmDialog, showFailToast, showSuccessToast, showToast } from 'vant'
import { saveBlob } from '@/shared/image-io'
import { createMemoryStore, openStore, type RecordStore } from './idb'
import {
  addCategory, categoryShares, DEFAULT_CATEGORIES, dateStrToTs, filterMonth, formatCents, KIND_LABEL, MAX_CATEGORY_LEN,
  MAX_NOTE_LEN, monthKey, newId, parseAmountToCents, parseImport, pickNewEntries, removeCategory, shiftMonth,
  shouldRemindBackup, summarize, toBackupJson, toCsv, tsToDateStr, type Entry, type Kind,
} from './logic'

/** 库名（全 App 共用一个库，每个工具一个 store） */
const DB_NAME = 'arkli'
/** 库版本：新增别的工具的 store 时要统一升级 */
const DB_VERSION = 1
/** 账目仓库名 */
const STORE_NAME = 'ledger'
/** 分类在 localStorage 里的键 */
const CAT_KEY = 'arkli:ledger:categories'
/** 上次导出时间在 localStorage 里的键 */
const EXPORT_KEY = 'arkli:ledger:lastExport'
/** 方向列表，用于渲染切换按钮 */
const KINDS: Kind[] = ['out', 'in']

/** 账目仓库，加载完成前为 undefined */
let store: RecordStore<Entry> | undefined
/** 全部账目 */
const entries = ref<Entry[]>([])
/** 当前查看的月份 */
const month = ref(monthKey(Date.now()))
/** 分类（按方向） */
const categories = ref<Record<Kind, string[]>>({
  out: [...DEFAULT_CATEGORIES.out],
  in: [...DEFAULT_CATEGORIES.in],
})
/** 已降级到内存存储（IndexedDB 不可用） */
const memoryOnly = ref(false)
/** 是否显示备份提醒 */
const remind = ref(false)
/** 占比图显示哪个方向 */
const shareKind = ref<Kind>('out')

/** 新增弹窗是否打开 */
const showForm = ref(false)
/** 表单：方向 */
const fKind = ref<Kind>('out')
/** 表单：金额文本 */
const fAmount = ref('')
/** 表单：分类 */
const fCategory = ref('')
/** 表单：备注 */
const fNote = ref('')
/** 表单：日期 */
const fDate = ref(tsToDateStr(Date.now()))
/** 表单：新分类输入 */
const fNewCat = ref('')
/** 是否处于分类删除模式 */
const catEdit = ref(false)
/** 导入用的隐藏文件框 */
const fileEl = ref<HTMLInputElement>()

/** 本月账目 */
const monthEntries = computed(() => filterMonth(entries.value, month.value))
/** 本月合计 */
const sum = computed(() => summarize(monthEntries.value))
/** 本月分类占比 */
const shares = computed(() => categoryShares(monthEntries.value, shareKind.value))
/** 当前表单方向下的分类 */
const formCats = computed(() => categories.value[fKind.value])

/** 读 localStorage，失败（隐私模式等）返回 null */
function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** 写 localStorage，失败忽略 */
function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 存储不可用就算了，下次打开用默认分类 */
  }
}

/** 从本地读分类，格式不对就保留默认 */
function loadCategories(): void {
  const raw = lsGet(CAT_KEY)
  if (!raw) return
  try {
    const c = JSON.parse(raw) as Partial<Record<Kind, unknown>>
    for (const k of KINDS) {
      const list = Array.isArray(c[k]) ? (c[k] as unknown[]).filter((x): x is string => typeof x === 'string') : []
      if (list.length) categories.value[k] = list
    }
  } catch {
    /* 坏数据忽略 */
  }
}

/** 保存分类 */
function saveCategories(): void {
  lsSet(CAT_KEY, JSON.stringify(categories.value))
}

/** 重新计算备份提醒 */
function updateRemind(): void {
  const last = Number(lsGet(EXPORT_KEY))
  remind.value = shouldRemindBackup(entries.value.length, last > 0 ? last : undefined, Date.now())
}

/** 打开仓库并载入账目；IndexedDB 不可用时退回内存 */
async function init(): Promise<void> {
  const indexes = [{ name: 'ts', keyPath: 'ts' }]
  try {
    store = await openStore<Entry>({ db: DB_NAME, version: DB_VERSION, store: STORE_NAME, indexes })
  } catch {
    store = createMemoryStore<Entry>(indexes)
    memoryOnly.value = true
  }
  entries.value = await store.getAll()
  updateRemind()
}

/** 打开新增弹窗并重置表单 */
function openForm(): void {
  fKind.value = 'out'
  fAmount.value = ''
  fNote.value = ''
  fDate.value = tsToDateStr(Date.now())
  fCategory.value = categories.value.out[0]
  catEdit.value = false
  showForm.value = true
}

/** 切换表单方向，分类跟着换 */
function setFormKind(k: Kind): void {
  fKind.value = k
  fCategory.value = categories.value[k][0]
  catEdit.value = false
}

/** 新增分类 */
function onAddCategory(): void {
  const next = addCategory(categories.value[fKind.value], fNewCat.value)
  if (next === categories.value[fKind.value]) {
    showToast(`分类名要 1~${MAX_CATEGORY_LEN} 个字，且不能重名`)
    return
  }
  categories.value[fKind.value] = next
  fCategory.value = fNewCat.value.trim()
  fNewCat.value = ''
  saveCategories()
}

/** 删除分类（已记的账目保留原分类名） */
function onRemoveCategory(name: string): void {
  categories.value[fKind.value] = removeCategory(categories.value[fKind.value], name)
  if (fCategory.value === name) fCategory.value = categories.value[fKind.value][0]
  saveCategories()
}

/** 保存一笔账 */
async function submit(): Promise<void> {
  const cents = parseAmountToCents(fAmount.value)
  if (cents === null) return void showFailToast('金额不对，最多两位小数')
  const ts = dateStrToTs(fDate.value)
  if (ts === null) return void showFailToast('日期不对')
  if (!fCategory.value) return void showFailToast('请选分类')
  const e: Entry = {
    id: newId(),
    amountCents: cents,
    kind: fKind.value,
    category: fCategory.value,
    note: fNote.value.trim().slice(0, MAX_NOTE_LEN),
    ts,
  }
  try {
    await store!.put(e)
  } catch {
    return void showFailToast('保存失败')
  }
  entries.value = [...entries.value, e]
  month.value = monthKey(ts)
  showForm.value = false
  updateRemind()
}

/** 删除一笔账（先确认） */
async function removeEntry(e: Entry): Promise<void> {
  try {
    await showConfirmDialog({ title: '删除这笔账？', message: `${e.category} ${formatCents(e.amountCents)}` })
  } catch {
    return
  }
  await store!.delete(e.id)
  entries.value = entries.value.filter((x) => x.id !== e.id)
  updateRemind()
}

/** 切换月份 */
function moveMonth(d: number): void {
  month.value = shiftMonth(month.value, d)
}

/** 导出：记下导出时间，关掉提醒 */
async function exportFile(text: string, name: string, mime: string): Promise<void> {
  try {
    const res = await saveBlob(new Blob([text], { type: mime }), name)
    lsSet(EXPORT_KEY, String(Date.now()))
    updateRemind()
    showSuccessToast(res.mode === 'native' ? '已保存到 Download/Arkli' : '已开始下载')
  } catch {
    showFailToast('导出失败')
  }
}

/** 导出 JSON 备份 */
function exportJson(): void {
  void exportFile(toBackupJson(entries.value, categories.value), `arkli-ledger-${tsToDateStr(Date.now())}.json`, 'application/json')
}

/** 导出 CSV */
function exportCsv(): void {
  void exportFile(toCsv(entries.value), `arkli-ledger-${tsToDateStr(Date.now())}.csv`, 'text/csv')
}

/** 选好 JSON 文件后导入：已有 id 跳过，分类并入 */
async function onFile(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    const r = parseImport(await file.text())
    const fresh = pickNewEntries(entries.value, r.entries)
    for (const e of fresh) await store!.put(e)
    entries.value = [...entries.value, ...fresh]
    if (r.categories) {
      for (const k of KINDS) for (const c of r.categories[k]) categories.value[k] = addCategory(categories.value[k], c)
      saveCategories()
    }
    updateRemind()
    showSuccessToast(`导入 ${fresh.length} 条${r.skipped ? `，跳过无效 ${r.skipped} 条` : ''}`)
  } catch (e) {
    showFailToast(e instanceof Error ? e.message : '导入失败')
  }
}

onMounted(() => {
  loadCategories()
  void init()
})
</script>

<template>
  <div class="tool-page">
    <van-notice-bar v-if="memoryOnly" wrapable :scrollable="false" text="本机存储不可用，账目只在这次打开期间有效，记得导出。" />
    <van-notice-bar v-else-if="remind" wrapable :scrollable="false" text="记录挺多了，或者很久没备份了，建议导出一份 JSON 存好。" />

    <div class="tool-card">
      <div class="lg-month">
        <van-button size="small" icon="arrow-left" plain aria-label="上个月" @click="moveMonth(-1)" />
        <strong>{{ month }}</strong>
        <van-button size="small" icon="arrow" plain aria-label="下个月" @click="moveMonth(1)" />
      </div>
      <div class="lg-sum">
        <div><span class="tool-hint">支出</span><b class="lg-out">{{ formatCents(sum.expense) }}</b></div>
        <div><span class="tool-hint">收入</span><b class="lg-in">{{ formatCents(sum.income) }}</b></div>
        <div><span class="tool-hint">结余</span><b>{{ formatCents(sum.balance) }}</b></div>
      </div>
    </div>

    <div class="tool-card">
      <h3 class="tool-card__title">分类占比</h3>
      <van-radio-group v-model="shareKind" direction="horizontal">
        <van-radio v-for="k in KINDS" :key="k" :name="k">{{ KIND_LABEL[k] }}</van-radio>
      </van-radio-group>
      <p v-if="!shares.length" class="tool-hint lg-gap">这个月还没有{{ KIND_LABEL[shareKind] }}记录</p>
      <ul v-else class="lg-bars">
        <li v-for="s in shares" :key="s.category">
          <div class="lg-bar-head">
            <span>{{ s.category }}</span>
            <span>{{ formatCents(s.cents) }}（{{ s.percent }}%）</span>
          </div>
          <div class="lg-bar"><i :class="shareKind === 'out' ? 'lg-fill-out' : 'lg-fill-in'" :style="{ width: s.percent + '%' }" /></div>
        </li>
      </ul>
    </div>

    <div class="tool-card">
      <h3 class="tool-card__title">明细（{{ monthEntries.length }} 笔）</h3>
      <p v-if="!monthEntries.length" class="tool-hint">点下面的按钮记第一笔</p>
      <van-cell-group v-else :border="false">
        <van-cell v-for="e in monthEntries" :key="e.id" :title="e.category" :label="`${tsToDateStr(e.ts)}${e.note ? ' · ' + e.note : ''}`" center>
          <template #value>
            <span :class="e.kind === 'out' ? 'lg-out' : 'lg-in'">{{ e.kind === 'out' ? '-' : '+' }}{{ formatCents(e.amountCents) }}</span>
          </template>
          <template #right-icon>
            <van-icon name="delete-o" class="lg-del" aria-label="删除" @click="removeEntry(e)" />
          </template>
        </van-cell>
      </van-cell-group>
    </div>

    <van-button type="primary" block round @click="openForm">记一笔</van-button>

    <div class="tool-card">
      <h3 class="tool-card__title">备份与导入</h3>
      <div class="tool-actions">
        <van-button size="small" @click="exportJson">导出 JSON</van-button>
        <van-button size="small" @click="exportCsv">导出 CSV</van-button>
        <van-button size="small" @click="fileEl?.click()">导入 JSON</van-button>
      </div>
      <input ref="fileEl" type="file" accept=".json,application/json" hidden @change="onFile" />
      <p class="tool-hint lg-gap">数据只存在本机，卸载或清除数据会丢，请定期导出。</p>
    </div>

    <van-popup v-model:show="showForm" position="bottom" round closeable teleport="body">
      <div class="lg-form">
        <h3 class="tool-card__title">记一笔</h3>
        <van-radio-group :model-value="fKind" direction="horizontal" @update:model-value="setFormKind">
          <van-radio v-for="k in KINDS" :key="k" :name="k">{{ KIND_LABEL[k] }}</van-radio>
        </van-radio-group>
        <van-field v-model="fAmount" label="金额" type="number" inputmode="decimal" placeholder="例如 12.5" />
        <van-field v-model="fDate" label="日期" type="date" />
        <van-field v-model="fNote" label="备注" :maxlength="MAX_NOTE_LEN" placeholder="选填" />
        <div class="lg-cat-head">
          <span class="tool-hint">分类</span>
          <van-button size="mini" plain @click="catEdit = !catEdit">{{ catEdit ? '完成' : '管理' }}</van-button>
        </div>
        <div class="lg-cats">
          <van-tag
            v-for="c in formCats"
            :key="c"
            size="large"
            :type="fCategory === c ? 'primary' : 'default'"
            :closeable="catEdit"
            @click="catEdit ? onRemoveCategory(c) : (fCategory = c)"
            @close="onRemoveCategory(c)"
          >{{ c }}</van-tag>
        </div>
        <van-field v-model="fNewCat" :maxlength="MAX_CATEGORY_LEN" placeholder="新分类名" center>
          <template #button><van-button size="small" @click="onAddCategory">添加</van-button></template>
        </van-field>
        <van-button type="primary" block round class="lg-submit" @click="submit">保存</van-button>
      </div>
    </van-popup>
  </div>
</template>

<style lang="scss" scoped>
/* 月份切换条 */
.lg-month {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

/* 三栏合计 */
.lg-sum {
  display: flex;
  justify-content: space-around;
  margin-top: $space-3;
  text-align: center;

  > div {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  b {
    font-size: 18px;
    font-variant-numeric: tabular-nums;
  }
}

/* 支出金额色 */
.lg-out {
  color: var(--c-error);
}

/* 收入金额色 */
.lg-in {
  color: var(--c-ok);
}

/* 提示与上方留距 */
.lg-gap {
  margin-top: $space-3;
}

/* 占比条列表 */
.lg-bars {
  display: flex;
  flex-direction: column;
  gap: $space-3;
  margin: $space-3 0 0;
  padding: 0;
  list-style: none;
}

/* 占比条上方文字行 */
.lg-bar-head {
  display: flex;
  justify-content: space-between;
  font-size: 13px;
  color: var(--c-text);
}

/* 占比条底槽 */
.lg-bar {
  height: 8px;
  margin-top: 4px;
  overflow: hidden;
  border-radius: 4px;
  background: var(--c-bg);

  i {
    display: block;
    height: 100%;
    border-radius: 4px;
  }
}

/* 支出条 */
.lg-fill-out {
  background: var(--c-error);
}

/* 收入条 */
.lg-fill-in {
  background: var(--c-ok);
}

/* 删除图标 */
.lg-del {
  margin-left: $space-3;
  font-size: 18px;
  color: var(--c-text-muted);
}

/* 弹窗内容 */
.lg-form {
  display: flex;
  flex-direction: column;
  gap: $space-3;
  padding: $space-4;
}

/* 分类标题行 */
.lg-cat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

/* 分类标签区 */
.lg-cats {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;
}

/* 保存按钮 */
.lg-submit {
  margin-top: $space-2;
}
</style>
