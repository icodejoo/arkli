// logo 渲染后端：同一份场景（Scene）分别画成 SVG 字符串（预览）和 Canvas（导出 PNG），两边坐标与样式一致。
// 文字不依赖 SVG 当图片再画进 canvas（Android WebView 里系统字体在 SVG 图片中不可靠），导出一律走 Canvas 2D 直接画。

import { buildScene } from './scene'
import type { IconItem, LogoParams, Scene, SceneItem, TextItem } from './types'

/** 图标原始视窗边长（Lucide 为 24） */
export const ICON_VIEWBOX = 24
/** 导出 PNG 的默认长边像素 */
export const EXPORT_LONG_SIDE = 1600
/** 导出 PNG 的最小长边像素（防止传 0） */
const EXPORT_MIN_SIDE = 64
/** 圆的整圈弧度 */
const FULL_TURN = Math.PI * 2

/**
 * 转义 XML 文本/属性里的特殊字符。
 *
 * @param s 原文
 * @returns 转义后的文本
 * @example escapeXml('A&B<C>') // 'A&amp;B&lt;C&gt;'
 */
export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/** 数字取两位小数，避免 SVG 里出现超长小数 */
function n(v: number): string {
  return String(Math.round(v * 100) / 100)
}

/** 填充与描边属性串：未给的填充为 none */
function paintAttrs(it: { fill?: string; stroke?: string; sw?: number }): string {
  const parts = [`fill="${it.fill ? escapeXml(it.fill) : 'none'}"`]
  if (it.stroke) parts.push(`stroke="${escapeXml(it.stroke)}" stroke-width="${n(it.sw ?? 1)}"`)
  return parts.join(' ')
}

/** 图标图元 → SVG（平移缩放后按描边画） */
function iconSvg(it: IconItem): string {
  const s = it.size / ICON_VIEWBOX
  return `<g transform="translate(${n(it.x)} ${n(it.y)}) scale(${Math.round(s * 10000) / 10000})" fill="none" stroke="${escapeXml(it.color)}" stroke-width="${n(it.sw)}" stroke-linecap="round" stroke-linejoin="round"><path d="${escapeXml(it.d)}"/></g>`
}

/** 文字图元 → SVG（字体栈里的双引号换成单引号，免得破坏属性） */
function textSvg(it: TextItem): string {
  const family = escapeXml(it.family.replace(/"/g, "'"))
  const spacing = it.spacing ? ` letter-spacing="${n(it.spacing)}"` : ''
  const italic = it.italic ? ' font-style="italic"' : ''
  return `<text x="${n(it.x)}" y="${n(it.y)}" font-size="${n(it.size)}" font-weight="${it.weight}" font-family="${family}" text-anchor="${it.anchor}" fill="${escapeXml(it.color)}"${spacing}${italic}>${escapeXml(it.text)}</text>`
}

/** 单个图元 → SVG 片段 */
function itemSvg(it: SceneItem): string {
  switch (it.k) {
    case 'rect':
      return `<rect x="${n(it.x)}" y="${n(it.y)}" width="${n(it.w)}" height="${n(it.h)}" rx="${n(it.rx)}" ${paintAttrs(it)}/>`
    case 'circle':
      return `<circle cx="${n(it.cx)}" cy="${n(it.cy)}" r="${n(it.r)}" ${paintAttrs(it)}/>`
    case 'path':
      return `<path d="${escapeXml(it.d)}" ${paintAttrs(it)} stroke-linejoin="round"/>`
    case 'icon':
      return iconSvg(it)
    case 'text':
      return textSvg(it)
  }
}

/**
 * 场景 → SVG 字符串（带 viewBox，宽度自适应，适合直接 v-html 预览）。
 *
 * @param scene 场景
 * @returns 完整的 `<svg>` 文本
 * @example renderSvg(buildScene(params))
 */
export function renderSvg(scene: Scene): string {
  const body = scene.items.map(itemSvg).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${scene.w} ${scene.h}" width="100%" height="100%"><rect width="${scene.w}" height="${scene.h}" fill="${escapeXml(scene.bg)}"/>${body}</svg>`
}

/**
 * 参数 → SVG 字符串。
 *
 * @param p logo 参数
 * @returns 完整的 `<svg>` 文本
 * @example el.innerHTML = renderLogoSvg(params)
 */
export function renderLogoSvg(p: LogoParams): string {
  return renderSvg(buildScene(p))
}

/** Canvas 2D 里画圆角矩形（不依赖较新的 roundRect） */
function rectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, rx: number): void {
  const r = Math.max(0, Math.min(rx, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** 按填充/描边画当前路径 */
function paint(ctx: CanvasRenderingContext2D, it: { fill?: string; stroke?: string; sw?: number }): void {
  if (it.fill) {
    ctx.fillStyle = it.fill
    ctx.fill()
  }
  if (it.stroke) {
    ctx.strokeStyle = it.stroke
    ctx.lineWidth = it.sw ?? 1
    ctx.lineJoin = 'round'
    ctx.stroke()
  }
}

/** Canvas 里画文字：字距靠 letterSpacing（不支持的环境自动忽略） */
function drawText(ctx: CanvasRenderingContext2D, it: TextItem): void {
  ctx.font = `${it.italic ? 'italic ' : ''}${it.weight} ${it.size}px ${it.family}`
  ctx.textAlign = it.anchor === 'middle' ? 'center' : 'left'
  ctx.textBaseline = 'alphabetic'
  ;(ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${it.spacing}px`
  ctx.fillStyle = it.color
  ctx.fillText(it.text, it.x, it.y)
}

/**
 * 把场景画进 Canvas 2D（先铺底色，再按顺序画图元）。
 *
 * @param ctx 目标上下文（调用方已按需 scale）
 * @param scene 场景
 * @example drawScene(canvas.getContext('2d')!, scene)
 */
export function drawScene(ctx: CanvasRenderingContext2D, scene: Scene): void {
  ctx.fillStyle = scene.bg
  ctx.fillRect(0, 0, scene.w, scene.h)
  for (const it of scene.items) {
    ctx.save()
    switch (it.k) {
      case 'rect':
        rectPath(ctx, it.x, it.y, it.w, it.h, it.rx)
        paint(ctx, it)
        break
      case 'circle':
        ctx.beginPath()
        ctx.arc(it.cx, it.cy, it.r, 0, FULL_TURN)
        paint(ctx, it)
        break
      case 'path':
        paintPath(ctx, it)
        break
      case 'icon':
        ctx.translate(it.x, it.y)
        ctx.scale(it.size / ICON_VIEWBOX, it.size / ICON_VIEWBOX)
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.lineWidth = it.sw
        ctx.strokeStyle = it.color
        ctx.stroke(new Path2D(it.d))
        break
      case 'text':
        drawText(ctx, it)
        break
    }
    ctx.restore()
  }
}

/** 路径图元：用 Path2D 画 */
function paintPath(ctx: CanvasRenderingContext2D, it: { d: string; fill?: string; stroke?: string; sw?: number }): void {
  const p = new Path2D(it.d)
  if (it.fill) {
    ctx.fillStyle = it.fill
    ctx.fill(p)
  }
  if (it.stroke) {
    ctx.strokeStyle = it.stroke
    ctx.lineWidth = it.sw ?? 1
    ctx.lineJoin = 'round'
    ctx.stroke(p)
  }
}

/**
 * 算导出像素尺寸：长边定为 longSide，按场景宽高比缩放。
 *
 * @param scene 场景
 * @param longSide 长边像素，默认 {@link EXPORT_LONG_SIDE}
 * @returns 像素宽高与缩放倍率
 * @example exportSize({ w: 600, h: 600 } as Scene) // { width: 1600, height: 1600, scale: 2.667 }
 */
export function exportSize(scene: Pick<Scene, 'w' | 'h'>, longSide = EXPORT_LONG_SIDE): { width: number; height: number; scale: number } {
  const side = Math.max(EXPORT_MIN_SIDE, Math.round(longSide))
  const scale = side / Math.max(scene.w, scene.h)
  return { width: Math.round(scene.w * scale), height: Math.round(scene.h * scale), scale }
}

/**
 * 把 logo 画到给定 canvas（会设置它的宽高）。
 *
 * @param canvas 目标画布
 * @param p logo 参数
 * @param longSide 长边像素，默认 {@link EXPORT_LONG_SIDE}
 * @example drawLogoToCanvas(el, params, 800)
 */
export function drawLogoToCanvas(canvas: HTMLCanvasElement, p: LogoParams, longSide = EXPORT_LONG_SIDE): void {
  const scene = buildScene(p)
  const { width, height, scale } = exportSize(scene, longSide)
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.scale(scale, scale)
  drawScene(ctx, scene)
}
