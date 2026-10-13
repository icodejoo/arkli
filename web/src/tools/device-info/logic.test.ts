import { describe, expect, it } from 'vitest'
import { androidVersionFromUa, chromeVersion, collectDeviceInfo, groupsToText, isWebView, NA, probeFeatures, type DeviceEnv } from './logic'

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
