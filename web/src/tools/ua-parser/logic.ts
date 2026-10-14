// UA 解析（自写，不引第三方库）：浏览器、渲染引擎、操作系统、设备类型与品牌
// 说明：UA 本身可伪造，且 Chrome / Safari 已冻结部分信息（Windows 11 与 10 同为 NT 10.0，
// macOS 固定写 10_15_7，iPadOS 13+ 默认伪装成 Mac），这里只能按 UA 字面给出最佳猜测。

/** 设备类型 */
export type DeviceType = 'mobile' | 'tablet' | 'desktop' | 'tv' | 'unknown'

/** 名称 + 版本，识别不出的字段为 null */
export interface NameVersion {
  /** 名称 */
  name: string | null
  /** 版本号原样字符串 */
  version: string | null
}

/** UA 解析结果 */
export interface UAResult {
  /** 浏览器（含微信、QQ 等 App 内核） */
  browser: NameVersion
  /** 渲染引擎 */
  engine: NameVersion
  /** 操作系统 */
  os: NameVersion
  /** 设备 */
  device: {
    /** 类型 */
    type: DeviceType
    /** 品牌（启发式猜测） */
    brand: string | null
    /** 型号（Android / 鸿蒙从 UA 括号里取） */
    model: string | null
  }
}

/** 设备类型的中文名 */
const DEVICE_LABELS: Record<DeviceType, string> = {
  mobile: '手机',
  tablet: '平板',
  desktop: '桌面电脑',
  tv: '电视',
  unknown: '未知',
}

/** 浏览器规则：[正则, 显示名]，正则第 1 个捕获组是版本；按顺序匹配，越具体越靠前 */
const BROWSER_RULES: Array<[RegExp, string]> = [
  [/wxwork\/([\d.]+)/i, '企业微信'],
  [/MicroMessenger\/([\d.]+)/i, '微信'],
  [/\bQQ\/([\d.]+)/, '手机QQ'],
  [/\bM?QQBrowser\/([\d.]+)/i, 'QQ浏览器'],
  [/UCBrowser\/([\d.]+)/i, 'UC浏览器'],
  [/Quark\/([\d.]+)/i, '夸克'],
  [/HuaweiBrowser\/([\d.]+)/i, '华为浏览器'],
  [/MiuiBrowser\/([\d.]+)/i, '小米浏览器'],
  [/HeyTapBrowser\/([\d.]+)/i, 'OPPO 浏览器'],
  [/VivoBrowser\/([\d.]+)/i, 'vivo 浏览器'],
  [/(?:baiduboxapp|baidubrowser|BIDUBrowser)\/([\d.]+)/i, '百度'],
  [/AlipayClient\/([\d.]+)/i, '支付宝'],
  [/DingTalk\/([\d.]+)/i, '钉钉'],
  [/SamsungBrowser\/([\d.]+)/i, 'Samsung Internet'],
  [/Edg(?:e|A|iOS)?\/([\d.]+)/, 'Edge'],
  [/OPR\/([\d.]+)/, 'Opera'],
  [/Opera\/[\d.]+.*Version\/([\d.]+)/, 'Opera'],
  [/(?:Firefox|FxiOS)\/([\d.]+)/, 'Firefox'],
  [/ArkWeb\/([\d.]+)/, 'ArkWeb（鸿蒙内核）'],
  [/(?:MSIE |Trident\/.*rv:)([\d.]+)/, 'IE'],
]

/** 品牌规则：model 针对型号字符串，ua 针对整条 UA；按顺序，先命中先得 */
const BRAND_RULES: Array<{ brand: string; model?: RegExp; ua?: RegExp }> = [
  { brand: '荣耀', ua: /HONOR/i },
  { brand: '华为', model: /^[A-Z0-9]{2,6}-(?:AL|TL|AN|BD|W|L|UL|CL|TN)\d{2}[A-Z]?$/, ua: /HUAWEI|HuaweiBrowser|HMSCore/i },
  {
    brand: '小米',
    model: /^(?:MI[ -]|Mi |Redmi|POCO|M\d{4}[A-Z]\d[A-Z]{1,3}\d?[A-Z]?$|\d{7,8}[A-Z]{1,3}\d?[A-Z]?$|\d{5}[A-Z]{3}\d[A-Z]$)/,
    ua: /Xiaomi|MIUI|MiuiBrowser/i,
  },
  { brand: 'iQOO', model: /^iQOO/i },
  { brand: 'vivo', model: /^(?:vivo|V\d{4}[A-Z]{0,2}$)/i, ua: /VivoBrowser/i },
  { brand: '一加', model: /^(?:HD|GM|IN|KB|LE|NE|DN)\d{4}$|^PH[A-Z]\d{3}$|^ONEPLUS/i, ua: /ONEPLUS/i },
  { brand: 'realme', model: /^(?:realme|RMX\d{4})/i },
  { brand: 'OPPO', model: /^(?:OPPO|CPH\d{4}$|P[A-Z]{3}\d{2}$)/, ua: /OPPO|HeyTapBrowser/i },
  { brand: '三星', model: /^(?:SM-|GT-|SC-|SAMSUNG)/i, ua: /SamsungBrowser/i },
  { brand: 'Google', model: /^(?:Pixel|Nexus)/ },
  { brand: '索尼', model: /^(?:SO-\d|SOV\d|SOG\d|XQ-)|Sony/i },
  { brand: '摩托罗拉', model: /^(?:moto|XT\d{4})|Motorola/i },
  { brand: '魅族', model: /^(?:MEIZU|M\d{3}[A-Z]$)/i },
  { brand: '联想', model: /^(?:Lenovo|L\d{5}$|TB-)/i },
  { brand: '努比亚', model: /^(?:nubia|NX\d+)/i },
  { brand: '中兴', model: /^ZTE/i },
  { brand: '华硕', model: /^ASUS/i },
  { brand: '诺基亚', model: /^Nokia/i },
]

/** iPad 改叫 iPadOS 的起始主版本 */
const IPADOS_MIN_MAJOR = 13

/** 括号里要忽略的片段：系统标记、语言、WebView 标记等 */
const IGNORED_SEGMENT =
  /^(?:Linux|U|wv|K|Mobile|Tablet|Phone|PC|2in1|HarmonyOS|OpenHarmony.*|Android.*|[a-z]{2}(?:[-_][a-zA-Z]{2})?|HMSCore.*|X11|Windows.*|Macintosh.*|Intel.*|.*Safari.*)$/i

/** 取第一个捕获组，没有匹配返回 null */
function cap(ua: string, re: RegExp): string | null {
  const m = re.exec(ua)
  return m ? (m[1] ?? '') : null
}

/**
 * 取主版本号。
 *
 * @param version 完整版本，如 "120.0.6099.144"
 * @returns 主版本 "120"；输入为空返回 null
 * @example
 * majorVersion('120.0.6099.144') // "120"
 */
export function majorVersion(version: string | null): string | null {
  if (!version) return null
  return version.split('.')[0] || null
}

/**
 * 设备类型的中文名。
 *
 * @param type 设备类型
 * @returns 中文名，如 "手机"
 * @example
 * deviceTypeLabel('tablet') // "平板"
 */
export function deviceTypeLabel(type: DeviceType): string {
  return DEVICE_LABELS[type]
}

/** 识别浏览器 */
function parseBrowser(ua: string): NameVersion {
  for (const [re, name] of BROWSER_RULES) {
    const v = cap(ua, re)
    if (v !== null) return { name, version: v || null }
  }
  // 沿用下面的优先级：WebView → Chrome 系 → Safari
  const chrome = cap(ua, /(?:Chrome|CriOS)\/([\d.]+)/)
  if (chrome !== null) {
    return { name: /;\s*wv\)/.test(ua) ? 'Android WebView' : 'Chrome', version: chrome || null }
  }
  const safari = cap(ua, /Version\/([\d.]+).*Safari/)
  if (safari !== null) return { name: 'Safari', version: safari || null }
  // iOS App 内的 WKWebView 没有 Safari 标记
  if (/(?:iPhone|iPad|iPod).*AppleWebKit/.test(ua) && !/Safari/.test(ua)) return { name: 'iOS WebView', version: null }
  if (/Safari\//.test(ua)) return { name: 'Safari', version: null }
  return { name: null, version: null }
}

/** 识别渲染引擎 */
function parseEngine(ua: string): NameVersion {
  const edgeHtml = cap(ua, /Edge\/([\d.]+)/)
  if (edgeHtml !== null) return { name: 'EdgeHTML', version: edgeHtml || null }
  const trident = cap(ua, /Trident\/([\d.]+)/)
  if (trident !== null) return { name: 'Trident', version: trident || null }
  const presto = cap(ua, /Presto\/([\d.]+)/)
  if (presto !== null) return { name: 'Presto', version: presto || null }
  const isIOS = /(?:iPhone|iPad|iPod)/.test(ua)
  const webkit = cap(ua, /AppleWebKit\/([\d.]+)/)
  // iOS 上所有浏览器都是 WebKit，哪怕 UA 里写了 Chrome / Firefox
  if (isIOS && webkit !== null) return { name: 'WebKit', version: webkit || null }
  const chrome = cap(ua, /Chrome\/([\d.]+)/)
  if (chrome !== null) return { name: 'Blink', version: chrome || null }
  if (/Gecko\/\d/.test(ua) && /Firefox\//.test(ua)) {
    return { name: 'Gecko', version: cap(ua, /rv:([\d.]+)/) || cap(ua, /Firefox\/([\d.]+)/) || null }
  }
  if (webkit !== null) return { name: 'WebKit', version: webkit || null }
  return { name: null, version: null }
}

/** Windows NT 版本号对应的名称 */
const WINDOWS_NT: Record<string, string> = {
  '10.0': '10 / 11',
  '6.3': '8.1',
  '6.2': '8',
  '6.1': '7',
  '6.0': 'Vista',
  '5.2': 'XP x64',
  '5.1': 'XP',
}

/** 识别操作系统 */
function parseOS(ua: string): NameVersion {
  if (/HarmonyOS/i.test(ua)) return { name: 'HarmonyOS', version: cap(ua, /HarmonyOS[ /]([\d.]+)/i) }
  if (/OpenHarmony/i.test(ua)) return { name: 'OpenHarmony', version: cap(ua, /OpenHarmony[ /]?([\d.]+)/i) }
  if (/Windows Phone/i.test(ua)) return { name: 'Windows Phone', version: cap(ua, /Windows Phone(?: OS)? ([\d.]+)/i) }
  const android = cap(ua, /Android[ /]?([\d.]+)?/)
  if (android !== null) return { name: 'Android', version: android || null }
  const ios = cap(ua, /(?:iPhone|iPad|iPod).*? OS ([\d_]+)/)
  if (ios !== null) {
    // iPad 自 13 起改叫 iPadOS
    const isIPadOS = /iPad/.test(ua) && Number(ios.split('_')[0]) >= IPADOS_MIN_MAJOR
    return { name: isIPadOS ? 'iPadOS' : 'iOS', version: ios.replace(/_/g, '.') }
  }
  if (/(?:iPhone|iPad|iPod)/.test(ua)) return { name: 'iOS', version: null }
  const nt = cap(ua, /Windows NT ([\d.]+)/)
  if (nt !== null) return { name: 'Windows', version: WINDOWS_NT[nt] ?? nt }
  const mac = cap(ua, /Mac OS X ([\d_.]+)/)
  if (mac !== null) return { name: 'macOS', version: mac.replace(/_/g, '.') }
  if (/Macintosh/.test(ua)) return { name: 'macOS', version: null }
  if (/CrOS/.test(ua)) return { name: 'ChromeOS', version: null }
  if (/Linux|X11/.test(ua)) return { name: 'Linux', version: null }
  return { name: null, version: null }
}

/** 从第一个括号里取型号：去掉系统、语言、WebView 等标记，剩下的第一段去掉 Build/xxx */
function parseModel(ua: string): string | null {
  const paren = /\(([^)]*)\)/.exec(ua)
  if (!paren) return null
  for (const raw of paren[1].split(';')) {
    const seg = raw.trim().replace(/\s*Build\/.*$/i, '')
    if (seg && !IGNORED_SEGMENT.test(seg)) return seg
  }
  return null
}

/** 判断设备类型 */
function parseDeviceType(ua: string, os: string | null): DeviceType {
  if (/SmartTV|SMART-TV|HbbTV|Tizen|Web0S|WebOS|BRAVIA|\bAFT[A-Z]|Android.*\bTV\b|GoogleTV/i.test(ua)) return 'tv'
  if (/iPad|Tablet|PlayBook|Kindle|Silk\//.test(ua)) return 'tablet'
  if (/iPhone|iPod|Windows Phone/.test(ua)) return 'mobile'
  if (os === 'Android') return /Mobile/.test(ua) ? 'mobile' : 'tablet'
  if (os === 'HarmonyOS' || os === 'OpenHarmony') {
    if (/\((?:Tablet)/.test(ua)) return 'tablet'
    if (/\((?:PC|2in1)/.test(ua)) return 'desktop'
    return /Mobile|\(Phone/.test(ua) ? 'mobile' : 'tablet'
  }
  if (os === 'Windows' || os === 'macOS' || os === 'Linux' || os === 'ChromeOS') return 'desktop'
  return 'unknown'
}

/** 猜品牌与型号 */
function parseBrandModel(ua: string, os: string | null): { brand: string | null; model: string | null } {
  if (/iPhone/.test(ua)) return { brand: 'Apple', model: 'iPhone' }
  if (/iPad/.test(ua)) return { brand: 'Apple', model: 'iPad' }
  if (/iPod/.test(ua)) return { brand: 'Apple', model: 'iPod' }
  if (os === 'macOS') return { brand: 'Apple', model: 'Mac' }
  const isPhoneOS = os === 'Android' || os === 'HarmonyOS' || os === 'OpenHarmony'
  const model = isPhoneOS ? parseModel(ua) : null
  if (!isPhoneOS) return { brand: null, model: null }
  for (const r of BRAND_RULES) {
    if ((model && r.model?.test(model)) || r.ua?.test(ua)) return { brand: r.brand, model }
  }
  return { brand: os === 'HarmonyOS' ? '华为' : null, model }
}

/**
 * 解析 UA 字符串。
 *
 * @param ua 浏览器 User-Agent，空串得到全是 null 的结果
 * @returns 浏览器、引擎、系统、设备四组信息；识别不出的字段为 null
 * @example
 * const r = parseUA(navigator.userAgent)
 * r.browser.name // "Chrome"
 * r.os.name      // "Windows"
 */
export function parseUA(ua: string): UAResult {
  const s = ua.trim()
  const os = parseOS(s)
  const { brand, model } = parseBrandModel(s, os.name)
  return {
    browser: parseBrowser(s),
    engine: parseEngine(s),
    os,
    device: { type: s ? parseDeviceType(s, os.name) : 'unknown', brand, model },
  }
}
