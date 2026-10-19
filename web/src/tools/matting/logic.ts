import type { MattingMode, MattingRefine, MattingResult } from '@/native/ai'

/** 抠图模式的展示顺序（也是页面标签页的顺序） */
export const MATTING_MODES: readonly MattingMode[] = ['portrait', 'general']

/** 模式对应的原生提供者 id（原生 `MattingMode.providerId`，两个模式各是一个提供者） */
export const PROVIDER_OF_MODE: Readonly<Record<MattingMode, string>> = {
  portrait: 'local-matting-portrait',
  general: 'local-matting-general',
}

/** 模式的中文名 */
export const MODE_LABELS: Readonly<Record<MattingMode, string>> = { portrait: '人像', general: '通用' }

/** 模式的一句话说明 */
export const MODE_HINTS: Readonly<Record<MattingMode, string>> = {
  portrait: '人像专用，发丝与边缘更细；深色背景配深色衣服时可能出现镂空。',
  general: '通用主体，物品、宠物都行，体积小；发丝等细节偏粗。',
}

/** 边缘细化档位的展示顺序与文案（分段控件） */
export const REFINE_OPTIONS: ReadonlyArray<{ value: MattingRefine; label: string }> = [
  { value: 'off', label: '关' },
  { value: 'light', label: '轻' },
  { value: 'standard', label: '标准' },
  { value: 'strong', label: '强' },
]

/** 边缘细化缺省档（与原生缺省一致） */
export const DEFAULT_REFINE: MattingRefine = 'strong'

/** 边缘细化说明小字 */
export const REFINE_HINT = '默认“强”；太强可能削掉极细的发丝，可以往回调。'

/** 记住细化档位的 localStorage 键 */
export const REFINE_STORAGE_KEY = 'arkli.matting.refine'

/** 精简存储接口，便于测试注入 */
export type RefineStorage = Pick<Storage, 'getItem' | 'setItem'>

/** 缓存文件的页面地址前缀（`/files/<cache 相对路径>`） */
export const FILES_PREFIX = '/files/'

/** 背景选项：透明 / 纯白 / 自定义颜色 */
export type BgKind = 'transparent' | 'white' | 'custom'

/** 背景选项的展示顺序与文案 */
export const BG_OPTIONS: ReadonlyArray<{ kind: BgKind; label: string }> = [
  { kind: 'transparent', label: '透明' },
  { kind: 'white', label: '纯白' },
  { kind: 'custom', label: '自定义' },
]

/** 纯白背景的颜色 */
export const WHITE_HEX = '#ffffff'

/** 自定义背景的默认颜色 */
export const DEFAULT_CUSTOM_HEX = '#3b6cf6'

/** 透明 PNG 的 MIME */
export const MIME_PNG = 'image/png'

/** 带底色导出的 JPG 的 MIME */
export const MIME_JPEG = 'image/jpeg'

/** 带底色导出的 JPG 质量 */
export const JPEG_QUALITY = 0.92

/** 文件名里不允许出现的字符 */
const UNSAFE_NAME_CHARS = /[\\/:*?"<>|\s]+/g

/** 没有源文件名时的主名 */
const DEFAULT_STEM = 'image'

/**
 * 由原生提供者 id 反查模式；不认识（含空）时回落到人像。
 *
 * @param providerId 提供者 id，如 `local-matting-general`
 * @returns 模式
 * @example modeOfProvider('local-matting-general') // 'general'
 */
export function modeOfProvider(providerId?: string | null): MattingMode {
  return MATTING_MODES.find((m) => PROVIDER_OF_MODE[m] === providerId) ?? 'portrait'
}

/**
 * 背景对应的颜色；透明返回 null（预览用棋盘格，导出保持 PNG）。
 *
 * @param kind 背景选项
 * @param custom 自定义颜色 `#rrggbb`
 * @returns `#rrggbb` 或 null
 * @example bgColorOf('white', '#000000') // '#ffffff'
 */
export function bgColorOf(kind: BgKind, custom: string): string | null {
  if (kind === 'transparent') return null
  return kind === 'white' ? WHITE_HEX : custom
}

/**
 * 导出文件名：`<源文件主名>_cutout.<扩展名>`，主名里的特殊字符换成下划线。
 *
 * @param sourceName 源图文件名，可为空
 * @param ext 扩展名（不带点），`png` 或 `jpg`
 * @returns 文件名
 * @example outputName('我的 照片.jpeg', 'png') // '我的_照片_cutout.png'
 */
export function outputName(sourceName: string | undefined, ext: string): string {
  const stem = (sourceName ?? '').replace(/\.[^./\\]+$/, '').replace(UNSAFE_NAME_CHARS, '_').replace(/^_+|_+$/g, '')
  return `${stem || DEFAULT_STEM}_cutout.${ext}`
}

/**
 * 缓存路径转页面可读地址。
 *
 * @param path 缓存相对路径，如 `cache/out/a.png`
 * @returns 如 `/files/cache/out/a.png`
 */
export function resultUrl(path: string): string {
  return FILES_PREFIX + path
}

/**
 * 结果摘要文案。
 *
 * @param r 抠图结果
 * @returns 如「1024×768 · 用时 812 ms（推理 640 ms）」
 * @example summaryOf({ width: 8, height: 6, elapsedMs: 9, inferMs: 7 } as never) // '8×6 · 用时 9 ms（推理 7 ms）'
 */
export function summaryOf(r: Pick<MattingResult, 'width' | 'height' | 'elapsedMs' | 'inferMs'>): string {
  return `${r.width}×${r.height} · 用时 ${r.elapsedMs} ms（推理 ${r.inferMs} ms）`
}

/**
 * 把任意值收敛成合法的细化档位，不认识的回落到缺省。
 *
 * @param v 待检查的值（如 localStorage 里读出的字符串）
 * @returns 合法档位
 * @example normalizeRefine('light') // 'light'；normalizeRefine('x') // 'strong'
 */
export function normalizeRefine(v: unknown): MattingRefine {
  return REFINE_OPTIONS.find((o) => o.value === v)?.value ?? DEFAULT_REFINE
}

/**
 * 读记住的细化档位；没有记录或读取失败都用缺省档。
 *
 * @param storage 存储，默认 localStorage（测试注入）
 * @returns 细化档位
 */
export function loadRefine(storage?: RefineStorage): MattingRefine {
  try {
    return normalizeRefine((storage ?? localStorage).getItem(REFINE_STORAGE_KEY))
  } catch {
    return DEFAULT_REFINE
  }
}

/**
 * 记住细化档位；写失败忽略（仅偏好）。
 *
 * @param refine 档位
 * @param storage 存储，默认 localStorage（测试注入）
 */
export function saveRefine(refine: MattingRefine, storage?: RefineStorage): void {
  try {
    ;(storage ?? localStorage).setItem(REFINE_STORAGE_KEY, refine)
  } catch {
    // 无存储环境，忽略
  }
}

/**
 * 切换细化档位后要不要自动重新抠一次：档位真的变了、且已经出过图（有图可抠）才重跑；
 * 还没出图只记住选择。
 *
 * @param prev 切换前档位
 * @param next 切换后档位
 * @param hasResult 当前是否已有抠图结果
 * @returns 需要重跑返回 true
 * @example shouldRerunOnRefine('strong', 'light', true) // true；(…, false) 为 false
 */
export function shouldRerunOnRefine(prev: MattingRefine, next: MattingRefine, hasResult: boolean): boolean {
  return prev !== next && hasResult
}
