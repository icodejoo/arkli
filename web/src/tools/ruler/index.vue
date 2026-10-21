<script setup lang="ts">
// 尺子：App 固定竖屏，尺子竖着贴在屏幕长边（左或右），Canvas 画刻度，靠实物（银行卡/硬币/自定义长度）校准像素与毫米的比例。
// 另有一条可上下拖动的游标，实时预览读数，并可在游标处打下任意多条彩色标记。
import ColorPicker from '@/shared/ColorPicker.vue'
import CellPicker from '@/shared/CellPicker.vue'
import type { CellOption } from '@/shared/cellPicker'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useFloatPause } from '@/shared/useFloatPause'
import { createToolStorage } from '@/shared/toolStorage'
import { usePersistedRef } from '@/shared/usePersistedRef'
import { showToast } from 'vant'
import { deviceDisplay } from '@/native/system'
import {
  buildTicks,
  CARD_MM,
  clampPos,
  COIN_MM,
  formatLength,
  formatReading,
  formatReadingAlt,
  gapMm,
  isValidScale,
  loadScale,
  SCALE_KEY,
  MARK_COLORS,
  mmToPx,
  nextColorIndex,
  pxToMm,
  resolveScale,
  saveScale,
  scaleFromCalibration,
  scaleFromDpi,
  sortMarksByPosition,
  STEP_MM,
  isHexColor,
  TOOL_NS,
  togglePick,
  type RulerMark,
  type RulerUnit,
} from './logic'

/** 尺子画布的短边（像素），即尺子的厚度 */
const THICKNESS = 84
/** 刻度数字的字号（像素） */
const LABEL_FONT = 12
/** 游标线与标记线的粗细（CSS 像素）；高分屏上渲染成 1 个物理像素 */
const LINE_WEIGHT = 0.5
/** 游标线、标记线离数字带的间隙（像素） */
const LINE_GAP = 2
/** 尺子与页面内容之间的留白（像素） */
const GAP = 8
/** 各级刻度线长度（像素） */
const TICK_LEN = { major: 36, half: 24, minor: 14 } as const
/** 校准线最短像素 */
const MIN_CAL_PX = 20
/** 游标的初始位置（像素，离零点） */
const CURSOR_INIT_PX = 120
/** 量不到顶栏时的兜底高度（像素），与 Vant 导航栏默认高度一致 */
const HEADER_FALLBACK = 46
/** 顶栏选择器：尺子要从它的下沿开始，不盖住顶栏 */
const HEADER_SELECTOR = '.van-nav-bar'
/** 间距对比图（SVG）的画布宽度，用户单位；实际宽度随弹窗自适应 */
const CMP_W = 340
/** 对比图每一行的高度 */
const CMP_ROW_H = 44
/** 对比图上下留白 */
const CMP_PAD_Y = 12
/** 对比图里圆点或 A/B 徽标的圆心 x */
const CMP_DOT_X = 18
/** 对比图里读数文字的起点 x */
const CMP_TEXT_X = 36
/** 对比图里每条标记横线的起点 x */
const CMP_LINE_X1 = 112
/** 对比图里每条标记横线的终点 x */
const CMP_LINE_X2 = 236
/** 对比图里尺寸标注竖线所在的 x */
const CMP_BRACKET_X = 322
/** 尺寸标注两端小横线的半长 */
const CMP_TICK = 6
/** 尺寸标注文字的右端 x，紧挨着竖线左侧 */
const CMP_LABEL_X = 310
/** 选中行的底色不透明度 */
const CMP_PICK_FILL = 0.14
/** 选中行的描边不透明度 */
const CMP_PICK_STROKE = 0.55
/** 校准线两端小竖线的半长（像素） */
const CAL_CAP = 8
/** 刻度数字离刻度线的偏移（像素） */
const LABEL_OFFSET = 12
/** 刻度数字的旋转角（弧度）：靠右顺时针 90°（从上往下读），靠左逆时针 90°（从下往上读） */
const LABEL_ROTATE = Math.PI / 2
/** 数字标签离两端的最小距离（像素），避免被裁掉 */
const LABEL_MARGIN = 8
/** 游标线比数字带再多伸出去的一点（像素） */
const LINE_OVERSHOOT = 8
/** 游标线与标记线的长度：从屏幕边缘画过整个数字带，再多伸出一点点 */
const LINE_LEN = TICK_LEN.major + LABEL_OFFSET + LABEL_FONT / 2 + LINE_OVERSHOOT
/** 读数小字离屏幕边缘的距离：紧挨着线的外端，放在空白带里 */
const TAG_OFFSET = LINE_LEN + LINE_GAP
/** 校准线距尺子基线（贴屏幕边缘的那一边）的距离（像素） */
const CAL_LINE_OFFSET = THICKNESS - 18
/** 尺面底色的不透明度 */
const SURFACE_ALPHA = 0.92
/** 参照物类型 */
type RefKind = 'card' | 'coin' | 'custom'
/** 尺子靠屏幕哪一侧 */
type EdgeSide = 'right' | 'left'

/** 持久缓存 */
const store = createToolStorage(TOOL_NS)

/** 单位选项 */
const UNIT_OPTIONS: CellOption[] = [
  { value: 'cm', label: '厘米' },
  { value: 'inch', label: '英寸' },
]
/** 当前单位（持久化） */
const unit = usePersistedRef<RulerUnit>(store, 'unit', 'cm', (v) => UNIT_OPTIONS.some((o) => o.value === v))
/** 尺子靠边选项 */
const SIDE_OPTIONS: CellOption[] = [
  { value: 'right', label: '靠右' },
  { value: 'left', label: '靠左' },
]
/** 校准参照物选项 */
const REF_OPTIONS: CellOption[] = [
  { value: 'card', label: '银行卡 85.6mm' },
  { value: 'coin', label: '一元硬币 25mm' },
  { value: 'custom', label: '自定义' },
]
/** 尺子靠右还是靠左（持久化） */
const side = usePersistedRef<EdgeSide>(store, 'side', 'right', (v) => SIDE_OPTIONS.some((o) => o.value === v))
/** 尺子顶端离视口顶部的距离（像素），即顶栏下沿 */
const topOffset = ref(HEADER_FALLBACK)
/** 尺子沿长边的像素长度：视口高度减去顶栏 */
const along = ref(640)
/** 已保存的校准比例（像素/毫米），null 表示未校准 */
const savedScale = ref<number | null>(loadScale(store))
/** 原生 dpi 算出的比例（像素/毫米），无宿主或取不到为 null */
const autoScale = ref<number | null>(null)
/** 生效的比例：手动校准优先，其次原生 dpi，最后 96dpi 估算 */
const scale = computed(() => resolveScale(savedScale.value, autoScale.value))
/** 是否处于校准模式 */
const calibrating = ref(false)
/** 参照物类型（持久化） */
const refKind = usePersistedRef<RefKind>(store, 'refKind', 'card', (v) => REF_OPTIONS.some((o) => o.value === v))
/** 自定义参照长度文本（毫米） */
const customMm = ref('50')
/** 校准线像素长度（用户调整） */
const calPx = ref(200)
/** 画布 */
const canvasRef = ref<HTMLCanvasElement>()

/** 游标位置：离尺子零点的像素距离 */
const cursorPx = ref(CURSOR_INIT_PX)
/** 用户在取色器里选的自定义颜色（持久化），没选过为 null */
const customColor = usePersistedRef<string | null>(store, 'customColor', null, (v) => v === null || isHexColor(v))
/** 当前选中的标记颜色：有缓存的自选色就接着用 */
const markColor = ref<string>(customColor.value ?? MARK_COLORS[0].value)
/** 最近一次选中的预设色下标：打完标记后从这里接着往下走，用户自选色不打断这个顺序 */
const colorIdx = ref(0)
/** 取色器绑定的颜色：没自选过就显示当前标记色，选了就同时改标记色 */
const pickerColor = computed({
  get: () => customColor.value ?? markColor.value,
  set: (v: string) => {
    customColor.value = v
    markColor.value = v
  },
})
/** 是否把尺子上的标记线藏起来（只影响显示，标记数据和列表都保留） */
const marksHidden = ref(false)
/** 间距对比弹窗是否打开 */
const compareOpen = ref(false)
/** 在对比弹窗里选中的标记编号，最多两个，先选的在前 */
const picked = ref<number[]>([])
/** 已打下的标记，不限数量 */
const marks = ref<RulerMark[]>([])
/** 标记编号自增序号 */
let markSeq = 0
/** 是否正在拖动游标 */
let dragging = false

/** 参照物实际长度（毫米），自定义不合法时为 0 */
const refMm = computed(() => (refKind.value === 'card' ? CARD_MM : refKind.value === 'coin' ? COIN_MM : Number(customMm.value) || 0))
/** 校准线是否能放进当前尺子（按当前比例估算） */
const calFits = computed(() => refMm.value > 0 && refMm.value * scale.value <= along.value)
/** 校准线按当前像素换算出的比例 */
const calScale = computed(() => scaleFromCalibration(calPx.value, refMm.value))
/** 校准线长度的上限 */
const calMax = computed(() => Math.max(MIN_CAL_PX + 1, Math.floor(along.value)))
/** 校准线当前长度的展示文本 */
const calText = computed(() => `${calPx.value.toFixed(1)} px 对应 ${refMm.value} mm`)
/** 比例是否合法（模板判断用） */
const scaleOk = computed(() => isValidScale(scale.value))
/** 整把尺子的实际长度文本 */
const totalText = computed(() => formatLength(along.value, scale.value, unit.value))
/** 使用说明里描述尺子所在位置的文本 */
const placeText = computed(() => `在${side.value === 'right' ? '右' : '左'}侧边缘，从顶栏下沿往下数`)
/** 尺子的悬浮定位：贴左或右边缘，从顶栏下沿铺到屏幕底边 */
const rulerStyle = computed(() => ({
  top: `${topOffset.value}px`,
  [side.value]: '0',
  width: `${THICKNESS}px`,
  height: `${along.value}px`,
}))
/** 页面内容给尺子让位：让出靠边那一侧 */
const pageStyle = computed(() => {
  const pad = `${THICKNESS + GAP}px`
  return side.value === 'right' ? { paddingRight: pad } : { paddingLeft: pad }
})

/** 游标当前离零点的毫米数 */
const cursorMm = computed(() => pxToMm(cursorPx.value, scale.value))
/** 预览区的主读数 */
const previewMain = computed(() => formatReading(cursorMm.value, unit.value))
/** 预览区的辅助读数 */
const previewAlt = computed(() => formatReadingAlt(cursorMm.value, unit.value))
/** 带像素位置与读数文本的标记，位置随校准比例换算，超出尺子的不画 */
const markViews = computed(() =>
  (marksHidden.value ? [] : marks.value)
    .map((m) => ({ ...m, px: mmToPx(m.mm, scale.value), text: formatReading(m.mm, unit.value) }))
    .filter((m) => m.px >= 0 && m.px <= along.value),
)

/**
 * 游标线或标记线的样式：横穿尺子的刻度区，只画到数字之前。
 *
 * @param px 离零点的像素位置
 * @param color 线的颜色
 * @returns 内联样式对象
 */
function lineStyle(px: number, color: string): Record<string, string> {
  return {
    top: `${px}px`,
    width: `${LINE_LEN}px`,
    height: `${LINE_WEIGHT}px`,
    marginTop: `${-LINE_WEIGHT / 2}px`,
    background: color,
    [side.value]: '0',
  }
}

/**
 * 读数小字的样式：放在数字带外侧，顺着尺子方向书写，用线的颜色。
 *
 * @param color 文字颜色
 * @returns 内联样式对象
 */
function tagStyle(color: string): Record<string, string> {
  return { color, [side.value]: `${TAG_OFFSET}px` }
}

/** 对比图的一行：一条标记加它在图上的位置与选中序号（0=A，1=B，-1 未选） */
interface CompareRow {
  id: number
  mm: number
  color: string
  text: string
  /** 行中线的 y */
  y: number
  /** 选中序号 */
  order: number
}
/** 选中序号对应的字母 */
const ORDER_LETTERS = ['A', 'B'] as const
/** 仍然存在的已选标记编号（标记被删后自动剔除） */
const pickedIds = computed(() => picked.value.filter((id) => marks.value.some((m) => m.id === id)))
/** 对比图的行：按位置从小到大、自上而下，行距均匀 */
const compareRows = computed<CompareRow[]>(() =>
  sortMarksByPosition(marks.value).map((m, i) => ({
    id: m.id,
    mm: m.mm,
    color: m.color,
    text: formatReading(m.mm, unit.value),
    y: CMP_PAD_Y + i * CMP_ROW_H + CMP_ROW_H / 2,
    order: pickedIds.value.indexOf(m.id),
  })),
)
/** 对比图的总高度 */
const compareHeight = computed(() => CMP_PAD_Y * 2 + compareRows.value.length * CMP_ROW_H)
/** 选满两条后，上方那条与下方那条（按图上位置） */
const comparePair = computed(() => {
  if (pickedIds.value.length < 2) return null
  const rows = compareRows.value.filter((r) => r.order >= 0).sort((a, b) => a.y - b.y)
  return rows.length === 2 ? { top: rows[0], bottom: rows[1] } : null
})
/** 两条标记之间的间距（毫米） */
const compareGapMm = computed(() => (comparePair.value ? gapMm(comparePair.value.top.mm, comparePair.value.bottom.mm) : 0))
/** 间距的主读数 */
const compareGapMain = computed(() => formatReading(compareGapMm.value, unit.value))
/** 间距的辅助读数 */
const compareGapAlt = computed(() => formatReadingAlt(compareGapMm.value, unit.value))

/** 点选对比图里的一行 */
function pickRow(id: number): void {
  picked.value = togglePick(pickedIds.value, id)
}

/** 打开间距对比弹窗，每次从没选开始 */
function openCompare(): void {
  picked.value = []
  compareOpen.value = true
}

/** 读 CSS 变量，读不到用兜底色 */
function cssColor(name: string, fallback: string): string {
  const el = canvasRef.value
  const v = el ? getComputedStyle(el).getPropertyValue(name).trim() : ''
  return v || fallback
}

/** 重新量一遍：顶栏下沿的位置，以及从那里到屏幕底边的长度 */
function measure(): void {
  const header = document.querySelector(HEADER_SELECTOR)
  // 用 offset 而不是 getBoundingClientRect：路由切换动画有 transform 位移，后者会量到动画中途的位置
  const bottom = header instanceof HTMLElement ? header.offsetTop + header.offsetHeight : HEADER_FALLBACK
  topOffset.value = bottom > 0 ? bottom : HEADER_FALLBACK
  along.value = Math.max(MIN_CAL_PX, Math.floor(window.innerHeight - topOffset.value))
}

/**
 * 把（沿尺方向 a，离基线距离 b）换算成画布坐标。
 * 基线就是贴着屏幕边缘的那一边：靠右时在画布右侧，靠左时在左侧。
 *
 * @param a 沿尺方向的位置（像素，从尺子零点起）
 * @param b 垂直尺方向、离基线的距离（像素）
 * @returns 画布上的 [x, y]
 */
function toXY(a: number, b: number): [number, number] {
  return side.value === 'right' ? [THICKNESS - b, a] : [b, a]
}

/** 画一条线，端点用（沿尺方向，离基线距离）表示 */
function line(ctx: CanvasRenderingContext2D, a: number, b: number, a2: number, b2: number): void {
  const [x1, y1] = toXY(a, b)
  const [x2, y2] = toXY(a2, b2)
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
}

/** 重画整把尺子 */
function draw(): void {
  const cv = canvasRef.value
  if (!cv) return
  const w = THICKNESS
  const h = along.value
  const dpr = window.devicePixelRatio || 1
  cv.width = Math.round(w * dpr)
  cv.height = Math.round(h * dpr)
  cv.style.width = `${w}px`
  cv.style.height = `${h}px`
  const ctx = cv.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  // 尺面底色：让刻度在任何页面背景上都看得清，同时标出"尺子在这里"
  ctx.fillStyle = cssColor('--c-surface', '#ffffff')
  ctx.globalAlpha = SURFACE_ALPHA
  ctx.fillRect(0, 0, w, h)
  ctx.globalAlpha = 1
  const text = cssColor('--c-text', '#1b1d22')
  const primary = cssColor('--c-primary', '#3b6cf6')
  ctx.strokeStyle = text
  ctx.fillStyle = text
  ctx.lineWidth = 1
  ctx.font = `${LABEL_FONT}px sans-serif`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  for (const t of buildTicks(along.value, scale.value, unit.value)) {
    const p = Math.round(t.pos) + 0.5
    line(ctx, p, 0, p, TICK_LEN[t.kind])
    if (t.label != null) {
      const lp = Math.max(LABEL_MARGIN, Math.min(along.value - LABEL_MARGIN, t.pos))
      const [x, y] = toXY(lp, TICK_LEN.major + LABEL_OFFSET)
      // 数字顺着尺子的方向书写：字头朝向屏幕边缘（刻度线一侧）
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(side.value === 'right' ? LABEL_ROTATE : -LABEL_ROTATE)
      ctx.fillText(t.label, 0, 0)
      ctx.restore()
    }
  }
  if (calibrating.value) {
    ctx.strokeStyle = primary
    ctx.lineWidth = 2
    line(ctx, 0, CAL_LINE_OFFSET, calPx.value, CAL_LINE_OFFSET)
    line(ctx, 0, CAL_LINE_OFFSET - CAL_CAP, 0, CAL_LINE_OFFSET + CAL_CAP)
    line(ctx, calPx.value, CAL_LINE_OFFSET - CAL_CAP, calPx.value, CAL_LINE_OFFSET + CAL_CAP)
  }
}

/** 单位、靠边或校准状态变化后重量重画 */
async function redraw(): Promise<void> {
  await nextTick()
  measure()
  draw()
}

/** 按当前比例下参照物的长度重置校准线（长度限制在尺子范围内） */
function syncCalPx(): void {
  const px = refMm.value * scale.value
  calPx.value = Math.max(MIN_CAL_PX, Math.min(calMax.value, Math.round(px * 2) / 2))
}

/** 进入校准模式 */
function startCalibrate(): void {
  calibrating.value = true
  syncCalPx()
}

/** 保存校准结果 */
function saveCalibrate(): void {
  const s = calScale.value
  if (s == null) {
    showToast('参照长度或线长不合理，没法校准')
    return
  }
  savedScale.value = s
  showToast(saveScale(s, store) ? '校准已保存' : '已生效，但存储不可用，下次要重新校准')
  calibrating.value = false
}

/** 清除校准，回到估算值 */
function resetCalibrate(): void {
  savedScale.value = null
  store.remove(SCALE_KEY)
  calibrating.value = false
  showToast('已清除校准')
}

/** 把游标移到手指所在的位置（clientY 减去尺子顶端即离零点的距离） */
function moveCursorTo(clientY: number): void {
  cursorPx.value = clampPos(clientY - topOffset.value, along.value)
}

/** 手指或鼠标按下：开始拖动，并立即把游标跳到按下的位置 */
function onPointerDown(e: PointerEvent): void {
  dragging = true
  try {
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  } catch {
    // 指针号无效（如合成事件）时不捕获，拖动仍按事件坐标工作
  }
  moveCursorTo(e.clientY)
}

/** 拖动中：游标跟手 */
function onPointerMove(e: PointerEvent): void {
  if (dragging) moveCursorTo(e.clientY)
}

/** 抬手或被系统打断：结束拖动 */
function onPointerUp(e: PointerEvent): void {
  dragging = false
  try {
    ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
  } catch {
    // 没捕获过就没有可释放的，忽略
  }
}

/**
 * 微调游标，每次一个固定步长，手指拖不准时用。
 *
 * @param dir 方向：-1 往零点方向，1 往远离零点方向
 */
function nudge(dir: -1 | 1): void {
  cursorPx.value = clampPos(cursorPx.value + mmToPx(dir * STEP_MM, scale.value), along.value)
}

/** 选中一个预设色，并记住它在循环里的位置 */
function pickPreset(index: number): void {
  colorIdx.value = index
  markColor.value = MARK_COLORS[index].value
}

/**
 * 在游标当前位置打一条选中颜色的标记，数量不限制；
 * 打完自动切到彩虹循环里的下一个颜色，用户可以再手动改选。
 * 标记线原本是隐藏的话会自动显示出来，免得打了却看不到。
 */
function addMark(): void {
  marks.value.push({ id: ++markSeq, mm: cursorMm.value, color: markColor.value })
  marksHidden.value = false
  pickPreset(nextColorIndex(colorIdx.value, MARK_COLORS.length))
}

/** 删除一条标记 */
function removeMark(id: number): void {
  marks.value = marks.value.filter((m) => m.id !== id)
}

/** 清空全部标记 */
function clearMarks(): void {
  marks.value = []
}

watch([unit, side, savedScale, autoScale, calibrating, calPx, refKind, customMm], redraw)
watch(refKind, syncCalPx)
watch(along, (v) => {
  cursorPx.value = clampPos(cursorPx.value, v)
})

/** 窗口尺寸变化与深浅色切换时重画 */
function onResize(): void {
  void redraw()
}

/** 向原生取屏幕 dpi 换算比例；失败静默，继续用估算 */
async function loadAutoScale(): Promise<void> {
  try {
    autoScale.value = scaleFromDpi(await deviceDisplay(), window.devicePixelRatio)
  } catch {
    // 取不到就保持估算
  }
}

/** 深色模式媒体查询，用于卸载时解绑 */
let mql: MediaQueryList | undefined
/** 挂上窗口尺寸与深浅色监听（先解绑再绑，不会重复） */
function bindListeners(): void {
  unbindListeners()
  window.addEventListener('resize', onResize)
  mql = window.matchMedia?.('(prefers-color-scheme: dark)')
  mql?.addEventListener?.('change', onResize)
}

/** 解绑窗口尺寸与深浅色监听 */
function unbindListeners(): void {
  window.removeEventListener('resize', onResize)
  mql?.removeEventListener?.('change', onResize)
  mql = undefined
}

/**
 * 浮起 / 离开前台：解绑 resize 与深浅色监听（页面已脱离文档，此时量尺寸会量到 0）；
 * 回来时重新绑定并按当前尺寸重量重画，期间屏幕转向或深浅色变化也能补上。
 * 校准、单位、标记点等状态都在 ref 里，不受影响。
 */
useFloatPause({
  pause: unbindListeners,
  resume: () => {
    bindListeners()
    void redraw()
  },
})

onMounted(() => {
  void loadAutoScale()
  void redraw()
  // 挂载当帧顶栏可能还没排好版，下一帧再量一次，避免尺子顶端与顶栏下沿差几像素
  requestAnimationFrame(() => void redraw())
  bindListeners()
})
onUnmounted(unbindListeners)
</script>

<template>
  <div class="tool-page" :style="pageStyle">
    <!-- 尺子悬浮在页面之上，贴着屏幕左或右边缘，从顶栏下沿铺到底；只有触摸层接收操作 -->
    <div class="ruler-box" :class="`ruler-box--${side}`" :style="rulerStyle">
      <canvas ref="canvasRef" class="ruler-canvas" aria-hidden="true" />
      <div
        v-for="m in markViews"
        :key="m.id"
        class="ruler-line"
        :style="lineStyle(m.px, m.color)"
      >
        <span class="ruler-line__tag" :style="tagStyle(m.color)">{{ m.text }}</span>
      </div>
      <div class="ruler-line ruler-line--cursor" :style="lineStyle(cursorPx, markColor)">
        <span class="ruler-line__tag" :style="tagStyle(markColor)">{{ previewMain }}</span>
        <i class="ruler-line__knob" :style="{ background: markColor }" />
      </div>
      <div
        class="ruler-touch"
        role="slider"
        aria-label="游标"
        :aria-valuenow="Math.round(cursorMm * 10) / 10"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
      />
    </div>

    <div v-if="!savedScale && autoScale" class="tool-hint ruler-warn">已按屏幕物理密度自动换算，一般不用校准；对不上实物再手动校准。</div>
    <div v-else-if="!savedScale" class="tool-hint ruler-warn">未校准，刻度仅供参考。拿银行卡或硬币校准一次就准了。</div>

    <tool-group title="游标读数">
      <p class="ruler-preview">{{ previewMain }}</p>
      <p class="tool-hint ruler-preview-alt">{{ previewAlt }}</p>
      <p class="tool-hint">在尺子上按住上下拖动游标；拖不准就用下面两个按钮微调。</p>
      <div class="tool-actions">
        <van-button size="small" @click="nudge(-1)">往上 0.1 mm</van-button>
        <van-button size="small" @click="nudge(1)">往下 0.1 mm</van-button>
      </div>
    </tool-group>

    <tool-group title="标记">
      <div class="ruler-swatches" role="radiogroup" aria-label="标记颜色">
        <button
          v-for="(c, i) in MARK_COLORS"
          :key="c.value"
          type="button"
          class="ruler-swatch"
          :class="{ 'ruler-swatch--on': markColor === c.value }"
          :style="{ background: c.value }"
          role="radio"
          :aria-checked="markColor === c.value"
          :aria-label="c.name"
          @click="pickPreset(i)"
        />
        <color-picker v-model="pickerColor" label="标记颜色" />
      </div>
      <div class="tool-actions ruler-gap">
        <van-button type="primary" size="small" @click="addMark">标记</van-button>
        <van-button size="small" :disabled="!marks.length" @click="marksHidden = !marksHidden">
          {{ marksHidden ? '显示标记' : '隐藏标记' }}
        </van-button>
        <van-button size="small" :disabled="!marks.length" @click="clearMarks">清除标记</van-button>
      </div>
      <van-button class="ruler-gap" size="small" plain block :disabled="marks.length < 2" @click="openCompare">间距对比</van-button>
      <van-cell-group v-if="marks.length" :border="false" class="ruler-gap">
        <van-cell v-for="m in marks" :key="m.id" center>
          <template #title>
            <span class="ruler-dot" :style="{ background: m.color }" />
            <span>{{ formatReading(m.mm, unit) }}</span>
          </template>
          <template #right-icon>
            <van-icon name="cross" class="ruler-del" aria-label="删除这条标记" @click="removeMark(m.id)" />
          </template>
        </van-cell>
      </van-cell-group>
      <p v-else class="tool-hint ruler-gap">点"标记"会在游标当前位置留下一条选中颜色的线，并标出读数，可以连续标记。</p>
    </tool-group>

    <van-popup v-model:show="compareOpen" position="bottom" round :style="{ height: '78%' }" safe-area-inset-bottom>
      <div class="cmp">
        <h3 class="tool-group__title cmp__title">标记间距</h3>
        <p class="tool-hint cmp__desc">点选两条标记，查看它们之间的间距。再点已选的取消，选第三条会替换最早选的。</p>
        <div class="cmp__scroll">
          <svg class="cmp__svg" :viewBox="`0 0 ${CMP_W} ${compareHeight}`" role="group" aria-label="标记列表，点选两条查看间距">
            <g
              v-for="r in compareRows"
              :key="r.id"
              class="cmp__row"
              role="button"
              tabindex="0"
              :aria-pressed="r.order >= 0"
              :aria-label="`标记 ${r.text}`"
              @click="pickRow(r.id)"
              @keydown.enter.prevent="pickRow(r.id)"
              @keydown.space.prevent="pickRow(r.id)"
            >
              <rect
                v-if="r.order >= 0"
                :x="4"
                :y="r.y - CMP_ROW_H / 2 + 2"
                :width="CMP_W - 8"
                :height="CMP_ROW_H - 4"
                rx="8"
                :fill="r.color"
                :fill-opacity="CMP_PICK_FILL"
                :stroke="r.color"
                :stroke-opacity="CMP_PICK_STROKE"
              />
              <rect :x="0" :y="r.y - CMP_ROW_H / 2" :width="CMP_W" :height="CMP_ROW_H" fill="transparent" />
              <circle :cx="CMP_DOT_X" :cy="r.y" :r="r.order >= 0 ? 10 : 5" :fill="r.color" />
              <text v-if="r.order >= 0" class="cmp__badge" :x="CMP_DOT_X" :y="r.y" text-anchor="middle" dominant-baseline="central">{{ ORDER_LETTERS[r.order] }}</text>
              <text class="cmp__text" :x="CMP_TEXT_X + (r.order >= 0 ? 6 : 0)" :y="r.y" dominant-baseline="central">{{ r.text }}</text>
              <line :x1="CMP_LINE_X1" :x2="CMP_LINE_X2" :y1="r.y" :y2="r.y" :stroke="r.color" stroke-width="1.5" />
            </g>
            <g v-if="comparePair" class="cmp__dim" aria-hidden="true">
              <line :x1="CMP_LINE_X2" :x2="CMP_BRACKET_X + CMP_TICK" :y1="comparePair.top.y" :y2="comparePair.top.y" class="cmp__guide" />
              <line :x1="CMP_LINE_X2" :x2="CMP_BRACKET_X + CMP_TICK" :y1="comparePair.bottom.y" :y2="comparePair.bottom.y" class="cmp__guide" />
              <line :x1="CMP_BRACKET_X" :x2="CMP_BRACKET_X" :y1="comparePair.top.y" :y2="comparePair.bottom.y" class="cmp__bracket" />
              <polygon
                :points="`${CMP_BRACKET_X - 4},${comparePair.top.y + 8} ${CMP_BRACKET_X + 4},${comparePair.top.y + 8} ${CMP_BRACKET_X},${comparePair.top.y}`"
                class="cmp__arrow"
              />
              <polygon
                :points="`${CMP_BRACKET_X - 4},${comparePair.bottom.y - 8} ${CMP_BRACKET_X + 4},${comparePair.bottom.y - 8} ${CMP_BRACKET_X},${comparePair.bottom.y}`"
                class="cmp__arrow"
              />
              <rect :x="CMP_LABEL_X - 62" :y="(comparePair.top.y + comparePair.bottom.y) / 2 - 11" width="64" height="22" rx="6" class="cmp__label-bg" />
              <text class="cmp__label" :x="CMP_LABEL_X" :y="(comparePair.top.y + comparePair.bottom.y) / 2" text-anchor="end" dominant-baseline="central">{{ compareGapMain }}</text>
            </g>
          </svg>
        </div>
        <!-- 结果固定在底部，高度恒定：选满前显示占位，选满后换成间距，上方内容不跳 -->
        <div class="cmp__footer" aria-live="polite">
          <template v-if="comparePair">
            <p class="cmp__gap">{{ compareGapMain }}</p>
            <p class="tool-hint cmp__alt">{{ compareGapAlt }}</p>
          </template>
          <p v-else class="tool-hint cmp__placeholder">还没选满两条，间距会显示在这里（已选 {{ pickedIds.length }}/2）</p>
        </div>
      </div>
    </van-popup>

    <tool-group title="怎么用">
      <p class="tool-hint">
        尺子贴着屏幕的长边，{{ placeText }}。把要量的东西贴着屏幕边放就行。零点在顶栏下沿，不在手机屏幕最顶端。
      </p>
      <p v-if="scaleOk" class="tool-hint ruler-total">尺长约 {{ totalText }}</p>
    </tool-group>

    <tool-group title="单位与位置">
      <cell-picker :model-value="unit" title="单位" :options="UNIT_OPTIONS" @update:model-value="unit = $event as RulerUnit" />
      <cell-picker :model-value="side" title="尺子位置" :options="SIDE_OPTIONS" @update:model-value="side = $event as EdgeSide" />
    </tool-group>

    <tool-group title="校准">
      <template v-if="!calibrating">
        <p class="tool-hint">不同手机的真实像素密度不一样，用实物对一下刻度才准。</p>
        <div class="tool-actions">
          <van-button type="primary" size="small" @click="startCalibrate">开始校准</van-button>
          <van-button v-if="savedScale" size="small" @click="resetCalibrate">清除校准</van-button>
        </div>
      </template>
      <template v-else>
        <cell-picker :model-value="refKind" title="参照物" :options="REF_OPTIONS" @update:model-value="refKind = $event as RefKind" />
        <van-field v-if="refKind === 'custom'" v-model="customMm" type="number" label="已知长度" placeholder="毫米" />
        <p class="tool-hint">把实物沿屏幕边缘的蓝线放好（蓝线从零点起），调整蓝线长度，直到与实物两端对齐。</p>
        <p v-if="!calFits" class="tool-hint ruler-warn">当前尺子放不下这个参照物，换小一点的参照物。</p>
        <van-slider v-model="calPx" :min="MIN_CAL_PX" :max="calMax" :step="0.5" class="ruler-slider" />
        <van-stepper v-model="calPx" input-width="64px" :min="MIN_CAL_PX" :max="calMax" :step="0.5" :decimal-length="1" />
        <p class="tool-hint">{{ calText }}</p>
        <div class="tool-actions">
          <van-button type="primary" size="small" @click="saveCalibrate">保存校准</van-button>
          <van-button size="small" @click="calibrating = false">取消</van-button>
        </div>
      </template>
    </tool-group>
  </div>
</template>

<style lang="scss" scoped>
/* 尺子容器：固定在视口边缘，盖过页面；自己不拦截点击，只有触摸层接收操作 */
.ruler-box {
  position: fixed;
  z-index: 100;
  pointer-events: none;
}

/* 画布铺满容器 */
.ruler-canvas {
  position: absolute;
  top: 0;
  left: 0;
  display: block;
}

/* 游标线与标记线：横穿尺子的刻度区，细到 0.5px，位置、长度和颜色由内联样式给 */
.ruler-line {
  position: absolute;
  pointer-events: none;

  /* 读数小字：竖排书写，方向与刻度数字一致；以线为中线垂直居中 */
  &__tag {
    position: absolute;
    top: 0;
    padding: 0 2px;
    font-size: 12px;
    font-weight: 600;
    line-height: 16px;
    white-space: nowrap;
    writing-mode: vertical-rl;
    transform: translateY(-50%);
  }

  /* 拖动把手：线的内端一个小圆点，随选中颜色，提示这里可以抓 */
  &__knob {
    position: absolute;
    top: -3.75px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }
}

/* 靠右：线从右边缘向内画，竖排文字顺时针（从上往下读），把手在左端 */
.ruler-box--right .ruler-line__knob {
  left: -4px;
}

/* 靠左：线从左边缘向内画，竖排文字翻 180° 变成逆时针（从下往上读），把手在右端 */
.ruler-box--left .ruler-line__tag {
  transform: translateY(-50%) rotate(180deg);
}


.ruler-box--left .ruler-line__knob {
  right: -4px;
}

/* 触摸层：只盖住尺子本身，禁掉浏览器的手势，才能顺畅地上下拖 */
.ruler-touch {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: auto;
  touch-action: none;
}

/* 间距对比弹窗：标题、结果在上，下面是可滚动的 SVG */
.cmp {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: $space-4;
  box-sizing: border-box;

  &__title {
    margin: 0 0 $space-2;
  }

  /* 顶部说明文字：固定不变，不随选择状态改动 */
  &__desc {
    margin: 0;
  }

  /* 结果区：固定在底部，高度恒定，内容变化不会推动上面的布局 */
  &__footer {
    flex: none;
    height: 84px;
    margin-top: $space-2;
    padding-top: $space-2;
    border-top: 1px solid var(--c-border, rgba(127, 127, 127, 0.25));
    box-sizing: border-box;
    overflow: hidden;
  }

  &__gap {
    margin: 0;
    font-size: 32px;
    font-weight: 700;
    line-height: 1.2;
    color: var(--c-text);
    font-variant-numeric: tabular-nums;
  }

  &__alt {
    margin: $space-1 0 0;
  }

  &__placeholder {
    margin: 0;
    line-height: 1.6;
  }

  &__scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    margin-top: $space-2;
  }

  &__svg {
    display: block;
    width: 100%;
    height: auto;
  }

  &__row {
    cursor: pointer;
    outline: none;
  }

  &__text {
    fill: var(--c-text);
    font-size: 14px;
    font-weight: 600;
  }

  &__badge {
    fill: #fff;
    font-size: 12px;
    font-weight: 700;
    pointer-events: none;
  }

  &__guide {
    stroke: var(--c-text-muted);
    stroke-width: 1;
    stroke-dasharray: 3 3;
  }

  &__bracket {
    stroke: var(--c-text);
    stroke-width: 1.5;
  }

  &__arrow {
    fill: var(--c-text);
  }

  &__label-bg {
    fill: var(--c-surface);
    fill-opacity: 0.95;
  }

  &__label {
    fill: var(--c-text);
    font-size: 13px;
    font-weight: 700;
  }
}

/* 预览区的大数字 */
.ruler-preview {
  margin: 0;
  font-size: 40px;
  font-weight: 700;
  line-height: 1.2;
  color: var(--c-text);
  font-variant-numeric: tabular-nums;
}

.ruler-preview-alt {
  margin: $space-1 0 $space-2;
}

/* 标记颜色选项 */
/* 一排颜色块：窄屏放不下就换行 */
.ruler-swatches {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: $space-2;
}

.ruler-swatch {
  width: 28px;
  height: 28px;
  padding: 0;
  border: 2px solid transparent;
  border-radius: 50%;
  box-shadow: 0 0 0 2px var(--c-surface) inset;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;

  &--on {
    border-color: var(--c-text);
  }
}

/* 标记列表里的色点 */
.ruler-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: $space-2;
  border-radius: 50%;
}

.ruler-del {
  padding: $space-1;
  color: var(--c-text-muted);
}

/* 未校准提示：警示色底 */
.ruler-warn {
  padding: $space-2 $space-3;
  border-radius: 10px;
  background: var(--c-warn-bg);
  color: var(--c-warn-text);
}

/* 总长提示 */
.ruler-total {
  margin: $space-2 0 0;
}

/* 单元间距 */
.ruler-gap {
  margin-top: $space-3;
}

/* 滑杆与前后元素留距 */
.ruler-slider {
  margin: $space-4 $space-2;
}
</style>
