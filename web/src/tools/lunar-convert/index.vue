<script setup lang="ts">
// 阳历/阴历互转：上阳历下阴历，输入与选择器都能改，改任一块另一块立刻联动
import { computed, ref } from 'vue'
import {
  HistoryError,
  classifyError,
  formatHistoryYear,
  historyErrorText,
  loadHistory,
  type HistoryEvent,
} from './history-today'
import {
  CALENDAR_NOTE,
  MAX_YEAR,
  MIN_YEAR,
  TABOO_NOTE,
  formatLunar,
  formatSolar,
  lunarDayOptions,
  lunarMonthOptions,
  lunarToSolar,
  solarDayOptions,
  solarMonthOptions,
  parseLunar,
  parseSolar,
  solarToLunar,
  tabooNote,
  todaySolar,
  yearOptions,
  type LunarDate,
  type LunarInfo,
  type SolarDate,
} from './logic'

/** 宜/忌列表的展示分组：key 用于记录展开状态 */
const TABOO_GROUPS = [
  { key: 'recommends', label: '宜', type: 'primary' },
  { key: 'avoids', label: '忌', type: 'danger' },
] as const

/** 宜忌分组的类型 */
type TabooKey = (typeof TABOO_GROUPS)[number]['key']
/** 说明面板底部小字 */
const NOTE_FOOT = '通俗说明，仅供参考'
/** 说明待核对时的提示 */
const NOTE_VERIFY = '此条说明待进一步核对'

/** 历史面板底部来源说明 */
const HISTORY_FOOT = '来源：维基百科（CC BY-SA 4.0）'

/** 阳历月份选项（固定不变，只算一次） */
const SOLAR_MONTHS = solarMonthOptions()

/** 当前生效的阳历日期（历史上的今天按它的月日查） */
const curSolar = ref<SolarDate>(todaySolar())
/** 历史面板是否显示 */
const showHistory = ref(false)
/** 历史数据状态：加载中 / 成功 / 失败 */
const histStatus = ref<'loading' | 'ok' | 'error'>('loading')
/** 历史事件列表 */
const histEvents = ref<HistoryEvent[]>([])
/** 历史加载失败时的提示 */
const histError = ref('')
/** 历史面板里已展开的条目下标 */
const histOpen = ref<Record<number, boolean>>({})
/** 历史面板标题 */
const histTitle = computed(() => `${curSolar.value.month} 月 ${curSolar.value.day} 日 · 历史上的今天`)
/** 阳历输入框文本 */
const solarText = ref('')
/** 阴历输入框文本 */
const lunarText = ref('')
/** 阳历块的行内错误 */
const solarError = ref('')
/** 阴历块的行内错误 */
const lunarError = ref('')
/** 当前阳历日期对应的阴历详情；还没有合法日期时为 null */
const info = ref<LunarInfo | null>(null)
/** 阳历选择器是否显示 */
const showSolarPicker = ref(false)
/** 阴历选择器是否显示 */
const showLunarPicker = ref(false)
/** 阳历选择器当前值：[年, 月, 日] */
const solarPick = ref<number[]>([])
/** 阴历选择器当前值：[年, 月（闰月为负数）, 日] */
const lunarPick = ref<number[]>([])
/** 事项说明面板是否显示 */
const showNote = ref(false)
/** 当前查看的事项：名称、属于宜还是忌 */
const noteItem = ref<{ name: string; key: TabooKey }>({ name: '', key: 'recommends' })
/** 当前事项的说明（查不到时为「暂无说明」） */
const note = computed(() => tabooNote(noteItem.value.name))
/** 阳历块的星期文案（阴历详情里已含，单独存是为了阴历不可用时也能显示） */
const solarWeek = computed(() => info.value?.week ?? '')

/**
 * 点击宜/忌标签，弹出该事项的说明。
 *
 * @param name 事项名
 * @param key 属于宜还是忌
 */
function openNote(name: string, key: TabooKey): void {
  noteItem.value = { name, key }
  showNote.value = true
}

/** 打开历史面板并加载当前阳历日期的月日（有缓存则不再请求） */
async function openHistory(): Promise<void> {
  showHistory.value = true
  histStatus.value = 'loading'
  histOpen.value = {}
  const { month, day } = curSolar.value
  try {
    const list = await loadHistory(month, day)
    histEvents.value = list
    histStatus.value = 'ok'
  } catch (e) {
    histError.value = historyErrorText(e instanceof HistoryError ? e.kind : classifyError(e))
    histStatus.value = 'error'
  }
}

/**
 * 切换某条历史事件的展开状态。
 *
 * @param i 条目下标
 */
function toggleHist(i: number): void {
  histOpen.value = { ...histOpen.value, [i]: !histOpen.value[i] }
}

/**
 * 应用一个合法阳历：回填两个输入框、重算阴历详情、清掉错误。
 *
 * @param d 合法阳历日期
 */
function applySolar(d: SolarDate): void {
  curSolar.value = d
  solarText.value = formatSolar(d)
  solarError.value = ''
  const r = solarToLunar(d)
  if (r.ok) {
    info.value = r.value
    lunarText.value = formatLunar(r.value.date)
    lunarError.value = ''
  } else {
    // 阳历合法但阴历超出范围：阴历块给提示，保留阳历
    info.value = null
    lunarText.value = ''
    lunarError.value = r.error
  }
}

/**
 * 阳历输入变化：完整且合法才联动；不完整不动；完整但非法在行内提示，不动阴历。
 *
 * @param text 输入框当前文本
 */
function onSolarInput(text: string): void {
  solarText.value = text
  const r = parseSolar(text)
  if (r.ok) applySolar(r.value)
  else solarError.value = r.incomplete ? '' : r.error
}

/**
 * 阴历输入变化：规则同阳历，合法后换算成阳历再整体回填。
 *
 * @param text 输入框当前文本
 */
function onLunarInput(text: string): void {
  lunarText.value = text
  const r = parseLunar(text)
  if (!r.ok) {
    lunarError.value = r.incomplete ? '' : r.error
    return
  }
  const s = lunarToSolar(r.value)
  if (s.ok) applySolar(s.value)
  else lunarError.value = s.error
}

/** 回到阳历今天 */
function goToday(): void {
  applySolar(todaySolar())
}

/** 打开阳历选择器，初始值取当前输入（不合法则用今天） */
function openSolarPicker(): void {
  const p = parseSolar(solarText.value)
  const d = p.ok ? p.value : todaySolar()
  solarPick.value = [d.year, d.month, d.day]
  showSolarPicker.value = true
}

/**
 * 修正阳历选择器的选中值：月变了天数可能不够（或落进 1582 年空档），日回退到最近的合法项。
 *
 * @param values 当前 [年, 月, 日]
 * @returns 合法的 [年, 月, 日]
 */
function normalizeSolarPick(values: number[]): number[] {
  const [y, m, d] = values as [number, number, number]
  const days = solarDayOptions(y, m).map((o) => o.value)
  const day = days.includes(d) ? d : (days.filter((x) => x < d).pop() ?? days[0] ?? 1)
  return [y, m, day]
}

/** 阳历选择器三列：年（窗口）、月、日；年列只含选中年前后一段，选中年变化时窗口重算 */
const solarColumns = computed(() => {
  const [y, m] = normalizeSolarPick(solarPick.value) as [number, number, number]
  return [yearOptions(y), SOLAR_MONTHS, solarDayOptions(y, m)]
})

/**
 * 阳历选择器滚动变化：回写修正后的值，让年窗口与日列表同步刷新。
 *
 * @param e 当前选中值
 */
function onSolarChange(e: { selectedValues: (string | number)[] }): void {
  solarPick.value = normalizeSolarPick(e.selectedValues.map(Number))
}

/**
 * 阳历选择器确认。
 *
 * @param e 选择结果，selectedValues 为 [年, 月, 日]
 */
function onSolarConfirm(e: { selectedValues: (string | number)[] }): void {
  const [y, m, d] = normalizeSolarPick(e.selectedValues.map(Number)) as [number, number, number]
  showSolarPicker.value = false
  applySolar({ year: y, month: m, day: d })
}

/** 打开阴历选择器，初始值取当前输入（不合法则取今天对应的阴历） */
function openLunarPicker(): void {
  let d: LunarDate | null = null
  const p = parseLunar(lunarText.value)
  if (p.ok) d = p.value
  else if (info.value) d = info.value.date
  else {
    const t = solarToLunar(todaySolar())
    if (t.ok) d = t.value.date
  }
  lunarPick.value = d ? [d.year, d.leap ? -d.month : d.month, d.day] : [todaySolar().year, 1, 1]
  showLunarPicker.value = true
}

/**
 * 修正阴历选择器的选中值：年变了闰月可能不存在，月变了天数可能不够，回退到最近合法项。
 *
 * @param values 当前 [年, 月, 日]
 * @returns 合法的 [年, 月, 日]
 */
function normalizeLunarPick(values: number[]): number[] {
  const [y, m, d] = values as [number, number, number]
  const months = lunarMonthOptions(y)
  const month = months.some((o) => o.value === m) ? m : Math.abs(m)
  const days = lunarDayOptions(y, month)
  return [y, month, Math.min(d, days.length)]
}

/** 阴历选择器三列：年（窗口）、月（闰月单列）、日（初一…三十），月日随上级联动 */
const lunarColumns = computed(() => {
  const [y, m] = normalizeLunarPick(lunarPick.value) as [number, number, number]
  return [yearOptions(y), lunarMonthOptions(y), lunarDayOptions(y, m)]
})

/**
 * 阴历选择器滚动变化：回写修正后的值，让下级列表同步刷新。
 *
 * @param e 当前选中值
 */
function onLunarChange(e: { selectedValues: (string | number)[] }): void {
  lunarPick.value = normalizeLunarPick(e.selectedValues.map(Number))
}

/**
 * 阴历选择器确认：换算成阳历后整体回填。
 *
 * @param e 选择结果，selectedValues 为 [年, 月, 日]
 */
function onLunarConfirm(e: { selectedValues: (string | number)[] }): void {
  const [y, m, d] = normalizeLunarPick(e.selectedValues.map(Number)) as [number, number, number]
  showLunarPicker.value = false
  const s = lunarToSolar({ year: y, month: Math.abs(m), day: d, leap: m < 0 })
  if (s.ok) applySolar(s.value)
  else lunarError.value = s.error
}

// 默认锁定阳历今天
applySolar(todaySolar())
</script>

<template>
  <div class="tool-page">
    <tool-group>
      <p class="tool-group__title">阳历</p>
      <van-field
        :model-value="solarText"
        label="日期"
        placeholder="2026-10-13，年可不补零"
        inputmode="numeric"
        autocomplete="off"
        right-icon="calendar-o"
        :error-message="solarError"
        @update:model-value="onSolarInput"
        @click-right-icon="openSolarPicker"
      />
      <p v-if="solarWeek && !solarError" class="tool-hint note">{{ solarWeek }}</p>
    </tool-group>

    <tool-group>
      <p class="tool-group__title">阴历</p>
      <van-field
        :model-value="lunarText"
        label="日期"
        placeholder="2026-09-03，闰月末尾加「闰」"
        autocomplete="off"
        right-icon="calendar-o"
        :error-message="lunarError"
        @update:model-value="onLunarInput"
        @click-right-icon="openLunarPicker"
      />
      <div v-if="info && !lunarError" class="detail">
        <div class="detail__main">{{ info.yearGanzhi }}年 {{ info.monthName }}{{ info.dayName }}</div>
        <div class="detail__sub">属{{ info.zodiac }} · {{ info.ganzhi }}</div>
        <div v-if="info.term" class="detail__term">今日节气：{{ info.term }}</div>
        <div v-if="info.duty || info.twelveStar" class="detail__sub">
          建除{{ info.duty || '—' }}日<template v-if="info.twelveStar"> · {{ info.twelveStar }}（{{ info.ecliptic }}）</template>
        </div>
      </div>
      <div v-if="info && !lunarError" class="taboo">
        <div v-for="g in TABOO_GROUPS" :key="g.key" class="taboo__row">
          <span class="taboo__label" :class="'taboo__label--' + g.type">{{ g.label }}</span>
          <div class="taboo__tags">
            <van-tag
              v-for="t in info[g.key]"
              :key="t"
              class="taboo__tag"
              :type="g.type"
              plain
              role="button"
              tabindex="0"
              @click="openNote(t, g.key)"
              @keydown.enter="openNote(t, g.key)"
            >
              {{ t }}
            </van-tag>
            <span v-if="!info[g.key].length" class="tool-hint">无</span>
          </div>
        </div>
      </div>
    </tool-group>

    <div class="tool-actions">
      <van-button type="primary" plain @click="goToday">回到今天</van-button>
    </div>
    <p class="tool-hint">{{ MIN_YEAR }}–{{ MAX_YEAR }} 年。输入（年可不补零，月日两位）或点右侧图标选择，改任一块另一块自动更新。</p>
    <p class="tool-hint">{{ CALENDAR_NOTE }}</p>
    <p class="tool-hint">{{ TABOO_NOTE }}</p>

    <van-button class="history-btn" block plain type="primary" icon="underway-o" @click="openHistory">查看历史上的今天</van-button>

    <van-popup v-model:show="showHistory" position="bottom" round closeable style="height: 80%">
      <div class="hist">
        <div class="hist__head">{{ histTitle }}</div>
        <div class="hist__body">
          <div v-if="histStatus === 'loading'" class="hist__state"><van-loading size="24" vertical>加载中…</van-loading></div>
          <div v-else-if="histStatus === 'error'" class="hist__state">
            <p class="hist__err">{{ histError }}</p>
            <van-button size="small" type="primary" plain @click="openHistory">重试</van-button>
          </div>
          <p v-else-if="!histEvents.length" class="hist__state tool-hint">这一天没有查到记录。</p>
          <ul v-else class="hist__list">
            <li v-for="(e, i) in histEvents" :key="i" class="hist__item">
              <button
                type="button"
                class="hist__row"
                :aria-expanded="e.note ? !!histOpen[i] : undefined"
                :disabled="!e.note"
                @click="toggleHist(i)"
              >
                <span class="hist__year">{{ formatHistoryYear(e.year) }}</span>
                <span class="hist__text">{{ e.text }}</span>
              </button>
              <div v-if="e.note && histOpen[i]" class="hist__note">
                <b>{{ e.note.title }}</b>
                <span v-if="e.note.desc">：{{ e.note.desc }}</span>
                <p v-if="e.note.extract">{{ e.note.extract }}</p>
              </div>
            </li>
          </ul>
        </div>
        <p class="hist__foot">{{ HISTORY_FOOT }}</p>
      </div>
    </van-popup>

    <van-popup v-model:show="showNote" position="bottom" round closeable>
      <div class="taboo-note">
        <div class="taboo-note__head">
          <span class="taboo-note__name">{{ noteItem.name }}</span>
          <span class="taboo-note__badge" :class="noteItem.key === 'recommends' ? 'taboo-note__badge--ok' : 'taboo-note__badge--bad'">
            {{ noteItem.key === 'recommends' ? '宜' : '忌' }}
          </span>
        </div>
        <p class="taboo-note__text">{{ note.text }}</p>
        <p v-if="note.source" class="taboo-note__verify">参考：{{ note.source }}</p>
        <p v-if="note.verify" class="taboo-note__verify">{{ NOTE_VERIFY }}</p>
        <p class="taboo-note__foot">{{ NOTE_FOOT }}</p>
      </div>
    </van-popup>

    <van-popup v-model:show="showSolarPicker" position="bottom" round>
      <van-picker
        :model-value="solarPick"
        title="选择阳历日期"
        :columns="solarColumns"
        @change="onSolarChange"
        @confirm="onSolarConfirm"
        @cancel="showSolarPicker = false"
      />
    </van-popup>

    <van-popup v-model:show="showLunarPicker" position="bottom" round>
      <van-picker
        :model-value="lunarPick"
        title="选择阴历日期"
        :columns="lunarColumns"
        @change="onLunarChange"
        @confirm="onLunarConfirm"
        @cancel="showLunarPicker = false"
      />
    </van-popup>
  </div>
</template>

<style lang="scss" scoped>
// 输入框下方的小字，与输入框拉开一点距离
.note {
  margin-top: 8px;
}

// 宜/忌：每行一个标签 + 一组小标签
.taboo {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--c-border);

  &__row {
    display: flex;
    gap: 10px;
    align-items: flex-start;

    & + & {
      margin-top: 10px;
    }
  }

  &__label {
    flex: none;
    width: 20px;
    font-size: 15px;
    font-weight: 600;
    line-height: 20px;

    &--primary {
      color: var(--c-primary);
    }

    &--danger {
      color: var(--c-error);
    }
  }

  &__tags {
    display: flex;
    flex: 1;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
    min-width: 0;
  }
}

// 标签可点：手型光标与按下态，不改布局
.taboo__tag {
  cursor: pointer;

  &:active {
    opacity: 0.6;
  }
}

// 事项说明面板
.taboo-note {
  padding: 20px 20px calc(16px + var(--safe-bottom));
  background: var(--c-surface);

  &__head {
    display: flex;
    gap: 8px;
    align-items: center;
    padding-right: 28px;
  }

  &__name {
    font-size: 18px;
    font-weight: 600;
    color: var(--c-text);
  }

  &__badge {
    padding: 0 6px;
    font-size: 12px;
    line-height: 18px;
    border: 1px solid currentcolor;
    border-radius: 4px;

    &--ok {
      color: var(--c-primary);
    }

    &--bad {
      color: var(--c-error);
    }
  }

  &__text {
    margin: 12px 0 0;
    font-size: 15px;
    line-height: 1.6;
    color: var(--c-text);
  }

  &__verify {
    margin: 10px 0 0;
    font-size: 12px;
    color: var(--c-text-muted);
    opacity: 0.8;
  }

  &__foot {
    margin: 14px 0 0;
    font-size: 12px;
    color: var(--c-text-muted);
  }
}

// 历史上的今天：按钮与面板
.history-btn {
  margin-top: 4px;
}

.hist {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--c-surface);

  &__head {
    flex: none;
    padding: 16px 48px 12px 16px;
    font-size: 16px;
    font-weight: 600;
    color: var(--c-text);
  }

  &__body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }

  &__state {
    padding: 48px 16px;
    text-align: center;
  }

  &__err {
    margin: 0 0 12px;
    font-size: 14px;
    color: var(--c-text-muted);
  }

  &__list {
    margin: 0;
    padding: 0 16px;
    list-style: none;
  }

  &__item {
    border-top: 1px solid var(--c-border);
  }

  &__row {
    display: flex;
    gap: 10px;
    width: 100%;
    padding: 9px 0;
    font: inherit;
    text-align: left;
    color: var(--c-text);
    background: none;
    border: 0;
    cursor: pointer;

    &:disabled {
      cursor: default;
    }

    &:not(:disabled):active {
      opacity: 0.6;
    }
  }

  &__year {
    flex: none;
    min-width: 76px;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.6;
    color: var(--c-primary);
    font-variant-numeric: tabular-nums;
  }

  &__text {
    flex: 1;
    font-size: 14px;
    line-height: 1.6;
  }

  &__note {
    margin: 0 0 10px 86px;
    padding: 8px 10px;
    font-size: 13px;
    line-height: 1.6;
    color: var(--c-text-muted);
    background: var(--c-bg);
    border-radius: 8px;

    b {
      color: var(--c-text);
    }

    p {
      margin: 4px 0 0;
    }
  }

  &__foot {
    flex: none;
    margin: 0;
    padding: 10px 16px calc(10px + var(--safe-bottom));
    font-size: 12px;
    color: var(--c-text-muted);
    border-top: 1px solid var(--c-border);
  }
}

// 阴历详情区：与输入框之间留距，主行突出
.detail {
  margin-top: 12px;
  text-align: center;

  &__main {
    font-size: 22px;
    font-weight: 600;
    color: var(--c-primary);
  }

  &__sub {
    margin-top: 4px;
    font-size: 13px;
    color: var(--c-text-muted);
  }

  &__term {
    margin-top: 6px;
    font-size: 13px;
    color: var(--c-ok);
  }
}
</style>
