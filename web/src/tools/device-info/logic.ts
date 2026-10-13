// 设备信息：只收集纯 Web 能拿到的字段，环境对象可注入以便测试（与 Vue 解耦）

/** 一行信息 */
export interface InfoItem {
  /** 名称 */
  label: string
  /** 值 */
  value: string
}

/** 一组信息 */
export interface InfoGroup {
  /** 组名 */
  title: string
  /** 组内各行 */
  items: InfoItem[]
}

/** 采集所需的环境（均可缺省，缺省的字段显示「不可用」） */
export interface DeviceEnv {
  /** navigator 子集 */
  nav?: {
    userAgent?: string
    language?: string
    languages?: readonly string[]
    hardwareConcurrency?: number
    deviceMemory?: number
    maxTouchPoints?: number
    onLine?: boolean
    platform?: string
    connection?: { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean }
  }
  /** screen 子集 */
  screen?: { width?: number; height?: number; availWidth?: number; availHeight?: number; colorDepth?: number; orientation?: { type?: string; angle?: number } }
  /** 视口与像素比 */
  viewport?: { innerWidth?: number; innerHeight?: number; devicePixelRatio?: number }
  /** 时区，如 Asia/Shanghai */
  timeZone?: string
  /** 媒体查询 */
  matchMedia?: (q: string) => { matches: boolean }
  /** 特性探测结果：名称 -> 是否支持 */
  features?: Record<string, boolean>
  /** WebGL 显卡型号 */
  gpu?: string
}

/** 未取到时显示的文本 */
export const NA = '不可用'
/** 是/否文本 */
const YES = '是'
/** 否文本 */
const NO = '否'

/**
 * 布尔转中文。
 *
 * @param b 布尔值
 * @returns 「是」或「否」
 */
function yn(b: boolean): string {
  return b ? YES : NO
}

/**
 * 判断 UA 是否像安卓 WebView。
 *
 * @param ua userAgent 字符串
 * @returns Android 且带 `; wv)` 标记，或带 `Version/x.x` 与 Chrome 并存（旧版 WebView 特征）为 true
 * @example
 * isWebView('Mozilla/5.0 (Linux; Android 10; X Build/Q; wv) Chrome/80.0.0.0 Mobile') // true
 */
export function isWebView(ua: string): boolean {
  if (!/Android/i.test(ua)) return false
  return /;\s*wv\)/i.test(ua) || (/Version\/\d+\.\d+/.test(ua) && /Chrome\/\d+/.test(ua))
}

/**
 * 从 UA 取 Chrome 内核主版本号。
 *
 * @param ua userAgent 字符串
 * @returns 主版本号文本；没有时为空串
 * @example
 * chromeVersion('... Chrome/80.0.3987.162 ...') // '80.0.3987.162'
 */
export function chromeVersion(ua: string): string {
  return /Chrome\/([\d.]+)/.exec(ua)?.[1] ?? ''
}

/**
 * 从 UA 取安卓版本。
 *
 * @param ua userAgent 字符串
 * @returns 如「10」；UA 里没有时为空串（现代 Chrome 会冻结为 10）
 */
export function androidVersionFromUa(ua: string): string {
  return /Android\s+([\d.]+)/.exec(ua)?.[1] ?? ''
}

/**
 * 数值转文本，缺失时返回「不可用」。
 *
 * @param v 数值
 * @param unit 单位后缀
 * @returns 如「8 核」
 */
function num(v: number | undefined, unit = ''): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${v}${unit}` : NA
}

/**
 * 收集设备信息，按分组返回。
 *
 * @param env 环境对象
 * @returns 信息分组数组，可直接渲染或转文本
 * @example
 * collectDeviceInfo({ nav: { userAgent: 'x' } })[0].title // '系统与浏览器'
 */
export function collectDeviceInfo(env: DeviceEnv): InfoGroup[] {
  const n = env.nav ?? {}
  const s = env.screen ?? {}
  const v = env.viewport ?? {}
  const ua = n.userAgent ?? ''
  const dpr = v.devicePixelRatio
  const physW = s.width != null && dpr != null ? Math.round(s.width * dpr) : undefined
  const physH = s.height != null && dpr != null ? Math.round(s.height * dpr) : undefined
  const mm = env.matchMedia
  const conn = n.connection
  const connText = conn
    ? [conn.effectiveType, conn.downlink != null ? `${conn.downlink} Mbps` : '', conn.rtt != null ? `${conn.rtt} ms` : '', conn.saveData ? '省流模式' : '']
        .filter(Boolean)
        .join(' / ') || NA
    : NA

  const groups: InfoGroup[] = [
    {
      title: '系统与浏览器',
      items: [
        { label: 'User-Agent', value: ua || NA },
        { label: '是否 WebView', value: ua ? yn(isWebView(ua)) : NA },
        { label: '内核版本', value: chromeVersion(ua) || NA },
        { label: 'UA 中的安卓版本', value: androidVersionFromUa(ua) || NA },
        { label: '平台', value: n.platform || NA },
      ],
    },
    {
      title: '屏幕',
      items: [
        { label: '屏幕分辨率（CSS px）', value: s.width != null && s.height != null ? `${s.width} × ${s.height}` : NA },
        { label: '物理像素估算', value: physW != null && physH != null ? `${physW} × ${physH}` : NA },
        { label: '可用尺寸', value: s.availWidth != null && s.availHeight != null ? `${s.availWidth} × ${s.availHeight}` : NA },
        { label: '视口尺寸', value: v.innerWidth != null && v.innerHeight != null ? `${v.innerWidth} × ${v.innerHeight}` : NA },
        { label: '像素比 devicePixelRatio', value: num(dpr) },
        { label: '色深', value: num(s.colorDepth, ' 位') },
        { label: '屏幕方向', value: s.orientation?.type ? `${s.orientation.type}（${s.orientation.angle ?? 0}°）` : NA },
        { label: '深色模式偏好', value: mm ? (mm('(prefers-color-scheme: dark)').matches ? '深色' : '浅色') : NA },
        { label: '减少动态效果', value: mm ? yn(mm('(prefers-reduced-motion: reduce)').matches) : NA },
      ],
    },
    {
      title: '硬件与输入',
      items: [
        { label: 'CPU 逻辑核数', value: num(n.hardwareConcurrency, ' 核') },
        { label: '设备内存（近似）', value: num(n.deviceMemory, ' GB') },
        { label: '最大触控点数', value: num(n.maxTouchPoints) },
        { label: 'GPU', value: env.gpu || NA },
      ],
    },
    {
      title: '语言、时区与网络',
      items: [
        { label: '语言', value: n.language || NA },
        { label: '语言列表', value: n.languages?.length ? n.languages.join(', ') : NA },
        { label: '时区', value: env.timeZone || NA },
        { label: '在线状态', value: n.onLine == null ? NA : n.onLine ? '在线' : '离线' },
        { label: '网络类型', value: connText },
      ],
    },
  ]
  const feats = env.features ?? {}
  const names = Object.keys(feats)
  if (names.length) groups.push({ title: '特性探测', items: names.map((k) => ({ label: k, value: yn(feats[k]) })) })
  return groups
}

/**
 * 把分组转成纯文本，便于一键复制。
 *
 * @param groups 信息分组
 * @returns 多行文本，组名单独一行，行内「名称：值」
 * @example
 * groupsToText([{ title: 'A', items: [{ label: 'x', value: '1' }] }]) // 'A\nx：1'
 */
export function groupsToText(groups: readonly InfoGroup[]): string {
  return groups.map((g) => [g.title, ...g.items.map((i) => `${i.label}：${i.value}`)].join('\n')).join('\n\n')
}

/**
 * 特性探测。每项都用 try 包起来，探测抛错按不支持算。
 *
 * @param w 全局对象（window）
 * @returns 名称 -> 是否支持
 */
export function probeFeatures(w: Record<string, unknown> & { navigator?: Record<string, unknown> }): Record<string, boolean> {
  const nav = w.navigator ?? {}
  /** 安全判断一个探测函数 */
  const t = (fn: () => boolean): boolean => {
    try {
      return !!fn()
    } catch {
      return false
    }
  }
  return {
    '方向传感器 DeviceOrientation': t(() => 'DeviceOrientationEvent' in w),
    '运动传感器 DeviceMotion': t(() => 'DeviceMotionEvent' in w),
    '屏幕常亮 wakeLock': t(() => 'wakeLock' in nav),
    '震动 vibrate': t(() => typeof nav.vibrate === 'function'),
    '剪贴板 clipboard': t(() => !!nav.clipboard),
    '系统分享 share': t(() => typeof nav.share === 'function'),
    WebAssembly: t(() => typeof w.WebAssembly === 'object'),
    'ArrayBuffer / TextEncoder': t(() => typeof w.ArrayBuffer === 'function' && typeof w.TextEncoder === 'function'),
    BigInt: t(() => typeof w.BigInt === 'function'),
    ResizeObserver: t(() => typeof w.ResizeObserver === 'function'),
    OffscreenCanvas: t(() => typeof w.OffscreenCanvas === 'function'),
    IndexedDB: t(() => !!w.indexedDB),
  }
}
