/**
 * 对象计数的纯算法：灰度 → Otsu 阈值 → 二值化 → 8 邻域连通域标记 → 面积过滤 → 手动修正。
 * 不依赖 DOM，输入输出都是普通数组，方便单测。
 */

/** 计算前图片最长边上限（再大就先缩小） */
export const MAX_EDGE = 800
/** 灰度级数 */
const LEVELS = 256
/** 取不到阈值时的兜底 */
const FALLBACK_THRESHOLD = 127
/** 默认最小面积占画面比例（万分之二） */
const MIN_AREA_RATIO = 0.0002
/** 最小面积兜底（像素） */
export const MIN_AREA_FLOOR = 4
/** 超过画面这个比例的连通域视为背景，丢弃 */
export const MAX_AREA_RATIO = 0.5
/** 点击命中已有标记的显示半径（屏幕像素） */
export const HIT_RADIUS_PX = 18

/** 物体相对背景的亮暗 */
export type ObjectMode = 'bright' | 'dark'

/** 连通域 */
export interface Component {
  /** 面积（像素数） */
  area: number
  /** 质心 x */
  cx: number
  /** 质心 y */
  cy: number
}

/** 计数标记点 */
export interface Marker {
  /** x（缩放后图像坐标） */
  x: number
  /** y（缩放后图像坐标） */
  y: number
}

/** 手动修正记录 */
export interface Edits {
  /** 手动添加的点 */
  added: Marker[]
  /** 被手动删除的自动点（按坐标精确匹配） */
  removed: Marker[]
}

/** 检测参数 */
export interface DetectOptions {
  /** 阈值 0~255 */
  threshold: number
  /** 物体亮暗 */
  mode: ObjectMode
  /** 最小面积（像素） */
  minArea: number
}

/**
 * RGBA 转灰度（透明像素按白底合成），整数 Rec.601 权重。
 *
 * @param data RGBA 字节，长度为 w*h*4
 * @param w 宽
 * @param h 高
 * @returns 长度 w*h 的灰度数组
 * @example toGray(new Uint8ClampedArray([255, 0, 0, 255]), 1, 1)[0] // 76
 */
export function toGray(data: ArrayLike<number>, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h)
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const a = data[p + 3] / 255
    const r = data[p] * a + 255 * (1 - a)
    const g = data[p + 1] * a + 255 * (1 - a)
    const b = data[p + 2] * a + 255 * (1 - a)
    out[i] = Math.round((r * 299 + g * 587 + b * 114) / 1000)
  }
  return out
}

/**
 * Otsu 大津法求全局阈值（类间方差最大）。
 *
 * @param gray 灰度数组
 * @returns 阈值 0~255，`<= t` 为一类、`> t` 为另一类；空数组返回 127
 * @example otsu(new Uint8Array([0, 0, 255, 255])) // 0
 */
export function otsu(gray: ArrayLike<number>): number {
  const n = gray.length
  if (!n) return FALLBACK_THRESHOLD
  const hist = new Array<number>(LEVELS).fill(0)
  let sum = 0
  for (let i = 0; i < n; i++) {
    hist[gray[i]]++
    sum += gray[i]
  }
  let wB = 0
  let sumB = 0
  let best = -1
  let threshold = 0
  for (let t = 0; t < LEVELS; t++) {
    wB += hist[t]
    if (wB === 0) continue
    const wF = n - wB
    if (wF === 0) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best) {
      best = between
      threshold = t
    }
  }
  return threshold
}

/**
 * 二值化：返回物体掩码（1 为物体）。
 *
 * @param gray 灰度数组
 * @param threshold 阈值
 * @param mode `bright` 亮物体（灰度 > 阈值），`dark` 暗物体（灰度 <= 阈值）
 * @returns 掩码
 * @example binarize(new Uint8Array([10, 200]), 100, 'dark') // Uint8Array [1, 0]
 */
export function binarize(gray: ArrayLike<number>, threshold: number, mode: ObjectMode): Uint8Array {
  const out = new Uint8Array(gray.length)
  for (let i = 0; i < gray.length; i++) {
    out[i] = (mode === 'bright' ? gray[i] > threshold : gray[i] <= threshold) ? 1 : 0
  }
  return out
}

/**
 * 猜物体是亮还是暗：边缘一圈多半是背景，背景亮则物体暗，反之亦然。
 *
 * @param gray 灰度数组
 * @param w 宽
 * @param h 高
 * @param threshold 阈值
 * @returns 推测的物体亮暗；边缘各占一半时按暗物体处理
 * @example guessMode(grayOfWhitePaperWithBlackDots, w, h, t) // 'dark'
 */
export function guessMode(gray: ArrayLike<number>, w: number, h: number, threshold: number): ObjectMode {
  let bright = 0
  let total = 0
  const visit = (x: number, y: number): void => {
    total++
    if (gray[y * w + x] > threshold) bright++
  }
  for (let x = 0; x < w; x++) {
    visit(x, 0)
    if (h > 1) visit(x, h - 1)
  }
  for (let y = 1; y < h - 1; y++) {
    visit(0, y)
    if (w > 1) visit(w - 1, y)
  }
  return bright * 2 >= total ? 'dark' : 'bright'
}

/**
 * 8 邻域连通域标记（迭代式，不递归，大图不爆栈）。
 *
 * @param mask 物体掩码（1 为物体），不会被修改
 * @param w 宽
 * @param h 高
 * @returns 所有连通域，按扫描顺序（先上后下、先左后右）
 * @example labelComponents(new Uint8Array([1, 1, 0, 0, 0, 1]), 3, 2).length // 2
 */
export function labelComponents(mask: ArrayLike<number>, w: number, h: number): Component[] {
  const seen = new Uint8Array(w * h)
  const stack = new Int32Array(w * h)
  const out: Component[] = []
  for (let start = 0; start < seen.length; start++) {
    if (!mask[start] || seen[start]) continue
    let sp = 0
    stack[sp++] = start
    seen[start] = 1
    let area = 0
    let sx = 0
    let sy = 0
    while (sp > 0) {
      const p = stack[--sp]
      const px = p % w
      const py = (p - px) / w
      area++
      sx += px
      sy += py
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy
        if (ny < 0 || ny >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx
          if ((dx === 0 && dy === 0) || nx < 0 || nx >= w) continue
          const q = ny * w + nx
          if (mask[q] && !seen[q]) {
            seen[q] = 1
            stack[sp++] = q
          }
        }
      }
    }
    out.push({ area, cx: sx / area, cy: sy / area })
  }
  return out
}

/**
 * 按面积过滤连通域：丢掉噪点（小于最小面积）和疑似背景（大于上限）。
 *
 * @param comps 连通域
 * @param minArea 最小面积（含）
 * @param maxArea 最大面积（含），默认不限
 * @returns 过滤后的连通域
 * @example filterByArea([{ area: 2, cx: 0, cy: 0 }, { area: 30, cx: 5, cy: 5 }], 10).length // 1
 */
export function filterByArea(comps: Component[], minArea: number, maxArea = Infinity): Component[] {
  return comps.filter((c) => c.area >= minArea && c.area <= maxArea)
}

/**
 * 默认的最小面积：随画面大小缩放，并有下限。
 *
 * @param w 宽
 * @param h 高
 * @returns 最小面积（像素）
 * @example defaultMinArea(800, 600) // 96
 */
export function defaultMinArea(w: number, h: number): number {
  return Math.max(MIN_AREA_FLOOR, Math.round(w * h * MIN_AREA_RATIO))
}

/**
 * 标记点排序：先上后下、同一行（相差不到 rowGap）从左到右，便于编号。
 *
 * @param points 标记点
 * @param rowGap 视为同一行的纵向容差
 * @returns 新数组
 * @example sortMarkers([{ x: 9, y: 0 }, { x: 1, y: 1 }], 5).map((p) => p.x) // [1, 9]
 */
export function sortMarkers(points: Marker[], rowGap: number): Marker[] {
  const byY = points.slice().sort((a, b) => a.y - b.y || a.x - b.x)
  const rows: Marker[][] = []
  let rowY = -Infinity
  for (const p of byY) {
    if (!rows.length || p.y - rowY > rowGap) {
      rows.push([p])
      rowY = p.y
    } else {
      rows[rows.length - 1].push(p)
    }
  }
  const out: Marker[] = []
  for (const r of rows) out.push(...r.sort((a, b) => a.x - b.x))
  return out
}

/**
 * 一站式检测：二值化 → 连通域 → 面积过滤，返回每个物体的质心。
 *
 * @param gray 灰度数组
 * @param w 宽
 * @param h 高
 * @param opts 阈值、亮暗、最小面积
 * @returns 自动标记点（未排序）
 * @example detect(gray, w, h, { threshold: 128, mode: 'dark', minArea: 4 }).length
 */
export function detect(gray: ArrayLike<number>, w: number, h: number, opts: DetectOptions): Marker[] {
  const comps = labelComponents(binarize(gray, opts.threshold, opts.mode), w, h)
  return filterByArea(comps, opts.minArea, w * h * MAX_AREA_RATIO).map((c) => ({ x: c.cx, y: c.cy }))
}

/** 空修正 */
export function emptyEdits(): Edits {
  return { added: [], removed: [] }
}

/**
 * 把手动修正叠加到自动结果上。
 *
 * @param auto 自动标记点
 * @param edits 手动修正
 * @returns 最终标记点：自动点去掉被删的，再加上手动添加的
 * @example visibleMarkers([{ x: 1, y: 1 }], { added: [{ x: 5, y: 5 }], removed: [{ x: 1, y: 1 }] }) // [{ x: 5, y: 5 }]
 */
export function visibleMarkers(auto: Marker[], edits: Edits): Marker[] {
  const gone = (p: Marker): boolean => edits.removed.some((r) => r.x === p.x && r.y === p.y)
  return auto.filter((p) => !gone(p)).concat(edits.added)
}

/**
 * 点击画面：命中已有标记（半径内最近的一个）则删除它，没命中则在点击处添加。
 *
 * @param auto 自动标记点
 * @param edits 当前修正
 * @param x 点击 x（图像坐标）
 * @param y 点击 y（图像坐标）
 * @param radius 命中半径（图像坐标）
 * @returns 新的修正记录（不修改入参）
 * @example toggleAt([{ x: 10, y: 10 }], emptyEdits(), 11, 10, 5).removed.length // 1
 */
export function toggleAt(auto: Marker[], edits: Edits, x: number, y: number, radius: number): Edits {
  const gone = (p: Marker): boolean => edits.removed.some((r) => r.x === p.x && r.y === p.y)
  let best: { kind: 'added' | 'auto'; index: number } | null = null
  let bestD = radius * radius
  edits.added.forEach((p, index) => {
    const d = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y)
    if (d <= bestD) {
      bestD = d
      best = { kind: 'added', index }
    }
  })
  auto.forEach((p, index) => {
    if (gone(p)) return
    const d = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y)
    if (d < bestD || (d === bestD && !best)) {
      bestD = d
      best = { kind: 'auto', index }
    }
  })
  const hit = best as { kind: 'added' | 'auto'; index: number } | null
  if (!hit) return { added: edits.added.concat([{ x, y }]), removed: edits.removed }
  if (hit.kind === 'added') return { added: edits.added.filter((_, i) => i !== hit.index), removed: edits.removed }
  return { added: edits.added, removed: edits.removed.concat([auto[hit.index]]) }
}

/** 持久缓存命名空间 */
export const STORE_NS = 'object-count'
