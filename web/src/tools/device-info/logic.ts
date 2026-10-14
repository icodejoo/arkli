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

// ---------------- 原生部分：把 native.device.* 的结果整理成分组 ----------------

/** 原生字段为 null 时显示的占位 */
export const DASH = '—'
/** 存储 / 内存换算进位 */
const BYTE_STEP = 1024
/** 容量单位序列 */
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']
/** 从这个下标（GB）起保留 2 位小数，更小的单位保留 1 位（B 不带小数） */
const GB_INDEX = 3
/** 毫伏换伏 */
const MV_PER_V = 1000
/** 传感器类型字符串里要去掉的前缀 */
const SENSOR_PREFIX = 'android.sensor.'

/** 原生静态信息的最小形状（兼容 `@/native/system` 的 DeviceInfo） */
export interface NativeInfo {
  /** 品牌 */
  brand: string | null
  /** 型号 */
  model: string | null
  /** 设备代号 */
  device: string | null
  /** 制造商 */
  manufacturer: string | null
  /** 系统版本号 */
  androidVersion: string | null
  /** API 级别 */
  sdkInt: number | null
  /** 安全补丁日期 */
  securityPatch: string | null
  /** 支持的 ABI */
  abis: string[]
  /** 是否鸿蒙 */
  harmonyOs: boolean | null
  /** 系统品牌 */
  osBrand: string | null
  /** 总内存（字节） */
  totalMemBytes: number | null
  /** 传感器列表 */
  sensors: Array<{ name: string; type: number; typeName: string | null }> | null
  /** 语言标签 */
  locale: string | null
  /** 时区 id */
  timeZone: string | null
  /** 系统特性开关 */
  features: Record<string, boolean | null>
}

/** 原生屏幕参数的最小形状（兼容 DeviceDisplay） */
export interface NativeDisplay {
  /** 真实宽（像素） */
  widthPx: number | null
  /** 真实高（像素） */
  heightPx: number | null
  /** 横向每英寸像素 */
  xdpi: number | null
  /** 纵向每英寸像素 */
  ydpi: number | null
  /** 密度桶 dpi */
  densityDpi: number | null
  /** 逻辑密度 */
  density: number | null
  /** 刷新率（Hz） */
  refreshRate: number | null
}

/** 原生动态状态的最小形状（兼容 DeviceStatus） */
export interface NativeStatus {
  /** 电量百分比 */
  batteryPercent: number | null
  /** 是否充电 */
  charging: boolean | null
  /** 充电状态中文 */
  chargeStatusText: string
  /** 供电方式 */
  plugType: string
  /** 供电方式中文 */
  plugText: string
  /** 电池温度（摄氏度） */
  batteryTempC: number | null
  /** 电池电压（毫伏） */
  batteryVoltageMv: number | null
  /** 可用内存（字节） */
  availMemBytes: number | null
  /** 是否低内存 */
  lowMemory: boolean | null
  /** 存储总量（字节） */
  storageTotalBytes: number | null
  /** 存储可用（字节） */
  storageFreeBytes: number | null
  /** 网络类型中文 */
  networkText: string | null
  /** 是否省电模式 */
  powerSave: boolean | null
}

/** 系统特性键 -> 中文名，没收录的键原样显示 */
export const FEATURE_LABELS: Record<string, string> = {
  nfc: 'NFC',
  bluetooth: '蓝牙',
  bluetoothLe: '低功耗蓝牙',
  fingerprint: '指纹',
  face: '人脸',
  gyroscope: '陀螺仪',
  accelerometer: '加速度计',
  compass: '磁力计',
  barometer: '气压计',
  light: '光线传感器',
  proximity: '距离传感器',
  camera: '摄像头',
  wifi: 'Wi-Fi',
  telephony: '电话',
  gps: 'GPS',
}

/**
 * 字节数转可读容量（1024 进位，GB 起两位小数）。
 *
 * @param bytes 字节数，null / 非法 / 负数显示「—」
 * @returns 如 `8.00 GB`
 * @example
 * formatBytes(8 * 1024 ** 3) // '8.00 GB'
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return DASH
  let v = bytes
  let i = 0
  while (v >= BYTE_STEP && i < BYTE_UNITS.length - 1) {
    v /= BYTE_STEP
    i++
  }
  if (i === 0) return `${Math.round(v)} B`
  return `${v.toFixed(i >= GB_INDEX ? 2 : 1)} ${BYTE_UNITS[i]}`
}

/**
 * 百分比，四舍五入取整。
 *
 * @param p 0~100，null / 非法显示「—」
 * @returns 如 `87%`
 * @example
 * formatPercent(86.6) // '87%'
 */
export function formatPercent(p: number | null | undefined): string {
  return typeof p === 'number' && Number.isFinite(p) ? `${Math.round(p)}%` : DASH
}

/**
 * 温度（摄氏度，一位小数）。
 *
 * @param c 摄氏度，null / 非法显示「—」
 * @returns 如 `36.5 ℃`
 * @example
 * formatTemp(36.54) // '36.5 ℃'
 */
export function formatTemp(c: number | null | undefined): string {
  return typeof c === 'number' && Number.isFinite(c) ? `${c.toFixed(1)} ℃` : DASH
}

/**
 * 电压：毫伏换成伏（两位小数）。
 *
 * @param mv 毫伏，null / 非法 / 0 以下显示「—」
 * @returns 如 `4.12 V`
 * @example
 * formatVoltage(4123) // '4.12 V'
 */
export function formatVoltage(mv: number | null | undefined): string {
  return typeof mv === 'number' && Number.isFinite(mv) && mv > 0 ? `${(mv / MV_PER_V).toFixed(2)} V` : DASH
}

/**
 * 刷新率，最多一位小数，整数不带小数点。
 *
 * @param hz 赫兹，null / 非法 / 0 以下显示「—」
 * @returns 如 `60 Hz`、`59.9 Hz`
 * @example
 * formatRefresh(59.94) // '59.9 Hz'
 */
export function formatRefresh(hz: number | null | undefined): string {
  return typeof hz === 'number' && Number.isFinite(hz) && hz > 0 ? `${Number(hz.toFixed(1))} Hz` : DASH
}

/**
 * 每英寸像素，最多一位小数。
 *
 * @param dpi 数值，null / 非法 / 0 以下显示「—」
 * @returns 如 `403.4`
 * @example
 * formatDpi(403.43) // '403.4'
 */
export function formatDpi(dpi: number | null | undefined): string {
  return typeof dpi === 'number' && Number.isFinite(dpi) && dpi > 0 ? String(Number(dpi.toFixed(1))) : DASH
}

/**
 * 字符串 / 数字字段：null、空串显示「—」。
 *
 * @param s 值
 * @returns 原文或「—」
 * @example
 * formatText(null) // '—'
 */
export function formatText(s: string | number | null | undefined): string {
  return s == null || s === '' ? DASH : String(s)
}

/**
 * 布尔转文案，null 显示「—」。
 *
 * @param b 布尔
 * @param yes 真值文案，默认「是」
 * @param no 假值文案，默认「否」
 * @returns 文案
 * @example
 * formatFlag(true, '支持', '不支持') // '支持'
 */
export function formatFlag(b: boolean | null | undefined, yes = '是', no = '否'): string {
  return b == null ? DASH : b ? yes : no
}

/**
 * 宽 × 高，任一缺失显示「—」。
 *
 * @param w 宽
 * @param h 高
 * @returns 如 `1080 × 2340`
 * @example
 * formatSize(1080, 2340) // '1080 × 2340'
 */
export function formatSize(w: number | null | undefined, h: number | null | undefined): string {
  return typeof w === 'number' && typeof h === 'number' ? `${w} × ${h}` : DASH
}

/**
 * 原生静态信息 + 屏幕参数 -> 分组（系统、屏幕、传感器、特性）。
 *
 * @param info 设备静态信息
 * @param display 屏幕参数，可为 null
 * @returns 分组数组；传感器 / 特性为空时对应组省略
 * @example
 * buildStaticGroups(info, display)[0].title // '系统（原生）'
 */
export function buildStaticGroups(info: NativeInfo, display: NativeDisplay | null): InfoGroup[] {
  const d = display
  const groups: InfoGroup[] = [
    {
      title: '系统（原生）',
      items: [
        { label: '品牌', value: formatText(info.brand) },
        { label: '型号', value: formatText(info.model) },
        { label: '设备代号', value: formatText(info.device) },
        { label: '制造商', value: formatText(info.manufacturer) },
        { label: '系统版本', value: formatText(info.androidVersion) },
        { label: 'SDK（API 级别）', value: formatText(info.sdkInt) },
        { label: '安全补丁', value: formatText(info.securityPatch) },
        { label: 'CPU ABI', value: info.abis?.length ? info.abis.join(', ') : DASH },
        { label: '鸿蒙', value: formatFlag(info.harmonyOs) },
        { label: '系统品牌', value: formatText(info.osBrand) },
        { label: '语言', value: formatText(info.locale) },
        { label: '时区', value: formatText(info.timeZone) },
      ],
    },
    {
      title: '屏幕（原生）',
      items: [
        { label: '分辨率（物理像素）', value: formatSize(d?.widthPx, d?.heightPx) },
        { label: 'xdpi', value: formatDpi(d?.xdpi) },
        { label: 'ydpi', value: formatDpi(d?.ydpi) },
        { label: '密度 densityDpi', value: formatDpi(d?.densityDpi) },
        { label: '逻辑密度 density', value: formatText(d?.density) },
        { label: '刷新率', value: formatRefresh(d?.refreshRate) },
      ],
    },
  ]
  if (info.sensors?.length) {
    groups.push({
      title: `传感器（${info.sensors.length}）`,
      items: info.sensors.map((s) => ({ label: s.name, value: s.typeName ? s.typeName.replace(SENSOR_PREFIX, '') : String(s.type) })),
    })
  }
  const keys = Object.keys(info.features ?? {})
  if (keys.length) {
    groups.push({ title: '系统特性', items: keys.map((k) => ({ label: FEATURE_LABELS[k] ?? k, value: formatFlag(info.features[k], '支持', '不支持') })) })
  }
  return groups
}

/**
 * 动态状态 -> 分组（电池、内存、存储、网络与省电）。
 *
 * @param status 动态状态
 * @param totalMemBytes 总内存（来自静态信息），可为 null
 * @returns 四个分组，字段缺失一律显示「—」
 * @example
 * buildStatusGroups(status, info.totalMemBytes).map((g) => g.title) // ['电池', '内存', '存储', '网络与省电']
 */
export function buildStatusGroups(status: NativeStatus, totalMemBytes: number | null): InfoGroup[] {
  const plugged = status.plugType && status.plugType !== 'none' ? `（${formatText(status.plugText)}）` : ''
  return [
    {
      title: '电池',
      items: [
        { label: '电量', value: formatPercent(status.batteryPercent) },
        { label: '充电状态', value: status.chargeStatusText ? `${status.chargeStatusText}${plugged}` : DASH },
        { label: '温度', value: formatTemp(status.batteryTempC) },
        { label: '电压', value: formatVoltage(status.batteryVoltageMv) },
      ],
    },
    {
      title: '内存',
      items: [
        { label: '总内存', value: formatBytes(totalMemBytes) },
        { label: '可用内存', value: formatBytes(status.availMemBytes) },
        { label: '低内存状态', value: formatFlag(status.lowMemory) },
      ],
    },
    {
      title: '存储',
      items: [
        { label: '总量', value: formatBytes(status.storageTotalBytes) },
        { label: '可用', value: formatBytes(status.storageFreeBytes) },
      ],
    },
    {
      title: '网络与省电',
      items: [
        { label: '网络类型', value: formatText(status.networkText) },
        { label: '省电模式', value: formatFlag(status.powerSave, '开启', '关闭') },
      ],
    },
  ]
}
