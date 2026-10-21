import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  androidVersionFromUa, buildStaticGroups, buildStatusGroups, chromeVersion, collectDeviceInfo, createPausableInterval, DASH, formatBytes, formatDpi, formatFlag,
  formatPercent, formatRefresh, formatSize, formatTemp, formatText, formatVoltage, groupsToText, isWebView, NA, probeFeatures,
  type DeviceEnv, type InfoGroup, type NativeDisplay, type NativeInfo,
} from './logic'

/** 取某组某行的值 */
function pick(env: DeviceEnv, title: string, label: string): string | undefined {
  return collectDeviceInfo(env)
    .find((g) => g.title === title)
    ?.items.find((i) => i.label === label)?.value
}

const WV_UA = 'Mozilla/5.0 (Linux; Android 10; STG-AL00 Build/HUAWEISTG-AL00; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/80.0.3987.162 Mobile Safari/537.36'
const CHROME_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'

describe('UA 解析', () => {
  it('WebView 识别', () => {
    expect(isWebView(WV_UA)).toBe(true)
    expect(isWebView(CHROME_UA)).toBe(false)
    expect(isWebView(DESKTOP_UA)).toBe(false)
    expect(isWebView('')).toBe(false)
  })
  it('内核与安卓版本', () => {
    expect(chromeVersion(WV_UA)).toBe('80.0.3987.162')
    expect(chromeVersion('nothing')).toBe('')
    expect(androidVersionFromUa(WV_UA)).toBe('10')
    expect(androidVersionFromUa(DESKTOP_UA)).toBe('')
  })
})

describe('collectDeviceInfo', () => {
  it('空环境不抛错，全部显示不可用', () => {
    const g = collectDeviceInfo({})
    expect(g.length).toBe(4)
    expect(pick({}, '硬件与输入', 'CPU 逻辑核数')).toBe(NA)
    expect(pick({}, '屏幕', '视口尺寸')).toBe(NA)
  })
  it('屏幕与物理像素估算', () => {
    const env: DeviceEnv = {
      screen: { width: 360, height: 740, availWidth: 360, availHeight: 700, colorDepth: 24 },
      viewport: { innerWidth: 360, innerHeight: 640, devicePixelRatio: 3 },
    }
    expect(pick(env, '屏幕', '屏幕分辨率（CSS px）')).toBe('360 × 740')
    expect(pick(env, '屏幕', '物理像素估算')).toBe('1080 × 2220')
    expect(pick(env, '屏幕', '色深')).toBe('24 位')
  })
  it('媒体查询与网络', () => {
    const env: DeviceEnv = {
      matchMedia: (q) => ({ matches: q.includes('dark') }),
      nav: { onLine: false, connection: { effectiveType: '4g', downlink: 10, rtt: 50 } },
    }
    expect(pick(env, '屏幕', '深色模式偏好')).toBe('深色')
    expect(pick(env, '屏幕', '减少动态效果')).toBe('否')
    expect(pick(env, '语言、时区与网络', '在线状态')).toBe('离线')
    expect(pick(env, '语言、时区与网络', '网络类型')).toBe('4g / 10 Mbps / 50 ms')
  })
  it('特性探测组仅在有数据时出现', () => {
    expect(collectDeviceInfo({ features: { A: true, B: false } })[4]).toEqual({ title: '特性探测', items: [{ label: 'A', value: '是' }, { label: 'B', value: '否' }] })
  })
})

describe('groupsToText', () => {
  it('分组之间空一行', () => {
    const t = groupsToText([
      { title: 'A', items: [{ label: 'x', value: '1' }] },
      { title: 'B', items: [{ label: 'y', value: '2' }] },
    ])
    expect(t).toBe('A\nx：1\n\nB\ny：2')
  })
})

describe('probeFeatures', () => {
  it('按对象内容探测；缺失按不支持', () => {
    const r = probeFeatures({ navigator: { vibrate: () => true, wakeLock: {} }, DeviceOrientationEvent: 1, BigInt: () => 0 })
    expect(r['震动 vibrate']).toBe(true)
    expect(r['屏幕常亮 wakeLock']).toBe(true)
    expect(r['方向传感器 DeviceOrientation']).toBe(true)
    expect(r['运动传感器 DeviceMotion']).toBe(false)
    expect(r.BigInt).toBe(true)
    expect(r.WebAssembly).toBe(false)
  })
  it('探测过程抛错不影响其它项', () => {
    const r = probeFeatures({ navigator: {} })
    expect(r['震动 vibrate']).toBe(false)
  })
})

describe('原生字段格式化', () => {
  it('formatBytes：B / KB / MB / GB 与非法值', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(5 * 1024 ** 2)).toBe('5.0 MB')
    expect(formatBytes(8 * 1024 ** 3)).toBe('8.00 GB')
    expect(formatBytes(1.5 * 1024 ** 4)).toBe('1.50 TB')
    expect(formatBytes(null)).toBe(DASH)
    expect(formatBytes(-1)).toBe(DASH)
    expect(formatBytes(Number.NaN)).toBe(DASH)
  })
  it('formatPercent / formatTemp / formatVoltage', () => {
    expect(formatPercent(86.6)).toBe('87%')
    expect(formatPercent(null)).toBe(DASH)
    expect(formatTemp(36.54)).toBe('36.5 ℃')
    expect(formatTemp(null)).toBe(DASH)
    expect(formatVoltage(4123)).toBe('4.12 V')
    expect(formatVoltage(0)).toBe(DASH)
    expect(formatVoltage(null)).toBe(DASH)
  })
  it('formatRefresh / formatDpi：整数不带小数点', () => {
    expect(formatRefresh(60)).toBe('60 Hz')
    expect(formatRefresh(59.94)).toBe('59.9 Hz')
    expect(formatRefresh(null)).toBe(DASH)
    expect(formatDpi(403.43)).toBe('403.4')
    expect(formatDpi(320)).toBe('320')
    expect(formatDpi(0)).toBe(DASH)
  })
  it('formatText / formatFlag / formatSize', () => {
    expect(formatText(null)).toBe(DASH)
    expect(formatText('')).toBe(DASH)
    expect(formatText(29)).toBe('29')
    expect(formatFlag(null)).toBe(DASH)
    expect(formatFlag(true, '支持', '不支持')).toBe('支持')
    expect(formatFlag(false)).toBe('否')
    expect(formatSize(1080, 2340)).toBe('1080 × 2340')
    expect(formatSize(null, 2340)).toBe(DASH)
  })
})

describe('buildStaticGroups / buildStatusGroups', () => {
  const info: NativeInfo = {
    brand: 'HUAWEI',
    model: 'STG-AL00',
    device: null,
    manufacturer: 'HUAWEI',
    androidVersion: '10',
    sdkInt: 29,
    securityPatch: '2021-05-01',
    abis: ['arm64-v8a', 'armeabi-v7a'],
    harmonyOs: true,
    osBrand: 'harmony',
    totalMemBytes: 8 * 1024 ** 3,
    sensors: [
      { name: 'Accel', type: 1, typeName: 'android.sensor.accelerometer' },
      { name: 'X', type: 99, typeName: null },
    ],
    locale: 'zh-CN',
    timeZone: 'Asia/Shanghai',
    features: { nfc: true, gyroscope: false, weird: null },
  }
  const display: NativeDisplay = { widthPx: 1080, heightPx: 2340, xdpi: 403.4, ydpi: 400, densityDpi: 420, density: 2.625, refreshRate: 60 }
  /** 取某行值 */
  const val = (gs: InfoGroup[], t: string, l: string) => gs.find((g) => g.title === t)?.items.find((i) => i.label === l)?.value

  it('静态：字段齐全并把 null 显示成「—」', () => {
    const gs = buildStaticGroups(info, display)
    expect(val(gs, '系统（原生）', '型号')).toBe('STG-AL00')
    expect(val(gs, '系统（原生）', '设备代号')).toBe(DASH)
    expect(val(gs, '系统（原生）', 'CPU ABI')).toBe('arm64-v8a, armeabi-v7a')
    expect(val(gs, '系统（原生）', '鸿蒙')).toBe('是')
    expect(val(gs, '屏幕（原生）', '分辨率（物理像素）')).toBe('1080 × 2340')
    expect(val(gs, '屏幕（原生）', '刷新率')).toBe('60 Hz')
    expect(val(gs, '传感器（2）', 'Accel')).toBe('accelerometer')
    expect(val(gs, '传感器（2）', 'X')).toBe('99')
    expect(val(gs, '系统特性', 'NFC')).toBe('支持')
    expect(val(gs, '系统特性', '陀螺仪')).toBe('不支持')
    expect(val(gs, '系统特性', 'weird')).toBe(DASH)
  })
  it('静态：display 为 null、无传感器与特性时不崩', () => {
    const gs = buildStaticGroups({ ...info, sensors: null, features: {} }, null)
    expect(gs.map((g) => g.title)).toEqual(['系统（原生）', '屏幕（原生）'])
    expect(val(gs, '屏幕（原生）', 'xdpi')).toBe(DASH)
  })
  it('动态：电池 / 内存 / 存储 / 网络', () => {
    const gs = buildStatusGroups(
      {
        batteryPercent: 80,
        charging: true,
        chargeStatusText: '充电中',
        plugType: 'usb',
        plugText: 'USB',
        batteryTempC: 31.2,
        batteryVoltageMv: 4000,
        availMemBytes: 2 * 1024 ** 3,
        lowMemory: false,
        storageTotalBytes: 128 * 1024 ** 3,
        storageFreeBytes: 64 * 1024 ** 3,
        networkText: 'Wi-Fi',
        powerSave: false,
      },
      info.totalMemBytes,
    )
    expect(gs.map((g) => g.title)).toEqual(['电池', '内存', '存储', '网络与省电'])
    expect(val(gs, '电池', '电量')).toBe('80%')
    expect(val(gs, '电池', '充电状态')).toBe('充电中（USB）')
    expect(val(gs, '电池', '电压')).toBe('4.00 V')
    expect(val(gs, '内存', '总内存')).toBe('8.00 GB')
    expect(val(gs, '内存', '可用内存')).toBe('2.00 GB')
    expect(val(gs, '存储', '可用')).toBe('64.00 GB')
    expect(val(gs, '网络与省电', '省电模式')).toBe('关闭')
  })
  it('动态：全 null 时都显示「—」，未接电源不带括号', () => {
    const gs = buildStatusGroups(
      {
        batteryPercent: null,
        charging: null,
        chargeStatusText: '放电中',
        plugType: 'none',
        plugText: '未接入',
        batteryTempC: null,
        batteryVoltageMv: null,
        availMemBytes: null,
        lowMemory: null,
        storageTotalBytes: null,
        storageFreeBytes: null,
        networkText: null,
        powerSave: null,
      },
      null,
    )
    expect(val(gs, '电池', '电量')).toBe(DASH)
    expect(val(gs, '电池', '充电状态')).toBe('放电中')
    expect(val(gs, '内存', '总内存')).toBe(DASH)
    expect(val(gs, '网络与省电', '网络类型')).toBe(DASH)
    expect(val(gs, '网络与省电', '省电模式')).toBe(DASH)
  })
})

describe('createPausableInterval', () => {
  afterEach(() => vi.useRealTimers())
  it('暂停后不再触发，恢复后继续', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const t = createPausableInterval(fn, 100)
    t.start()
    vi.advanceTimersByTime(250)
    expect(fn).toHaveBeenCalledTimes(2)
    t.pause()
    vi.advanceTimersByTime(1000)
    expect(fn).toHaveBeenCalledTimes(2)
    expect(t.resume()).toBe(true)
    vi.advanceTimersByTime(100)
    expect(fn).toHaveBeenCalledTimes(3)
  })
  it('重复暂停/恢复幂等', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const t = createPausableInterval(fn, 100)
    t.start()
    t.pause()
    t.pause()
    expect(t.resume()).toBe(true)
    expect(t.resume()).toBe(false)
    vi.advanceTimersByTime(100)
    expect(fn).toHaveBeenCalledTimes(1)
  })
  it('没开启时暂停/恢复无副作用；stop 后恢复不重开', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const t = createPausableInterval(fn, 100)
    t.pause()
    expect(t.resume()).toBe(false)
    t.start()
    t.pause()
    t.stop()
    expect(t.resume()).toBe(false)
    vi.advanceTimersByTime(500)
    expect(fn).not.toHaveBeenCalled()
  })
})
