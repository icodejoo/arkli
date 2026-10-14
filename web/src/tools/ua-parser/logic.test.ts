import { describe, expect, it } from 'vitest'
import { deviceTypeLabel, majorVersion, parseUA } from './logic'

/** 一批真实形态的 UA 字符串 */
const UA = {
  chromeWin:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.2210.91',
  edgeLegacy:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/64.0.3282.140 Safari/537.36 Edge/18.19582',
  firefoxWin: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/115.0',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  safariIPhone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
  chromeIPad:
    'Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1',
  wechatAndroid:
    'Mozilla/5.0 (Linux; Android 13; 2201123C Build/TKQ1.221114.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.0.0 Mobile Safari/537.36 XWEB/1160065 MMWEBSDK/20231002 MMWEBID/9172 MicroMessenger/8.0.43.2480(0x28002B3F) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64',
  wechatIOS:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.42(0x18002a2a) NetType/WIFI Language/zh_CN',
  qqApp:
    'Mozilla/5.0 (Linux; Android 12; PEGM10 Build/RKQ1.211119.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/89.0.4389.72 MQQBrowser/6.2 TBS/046247 Mobile Safari/537.36 V1_AND_SQ_8.9.50_3898_YYB_D QQ/8.9.50.10650 NetType/WIFI',
  qqBrowser:
    'Mozilla/5.0 (Linux; U; Android 11; zh-cn; V2049A Build/RP1A.200720.012) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/89.0.4389.72 MQQBrowser/13.1 Mobile Safari/537.36',
  uc: 'Mozilla/5.0 (Linux; U; Android 10; zh-CN; ELE-AL00 Build/HUAWEIELE-AL00) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/78.0.3904.108 UCBrowser/13.4.0.1306 Mobile Safari/537.36',
  huaweiBrowser:
    'Mozilla/5.0 (Linux; Android 12; HarmonyOS; NOH-AN00; HMSCore 6.12.0.302) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.4844.88 HuaweiBrowser/13.0.5.303 Mobile Safari/537.36',
  miBrowser:
    'Mozilla/5.0 (Linux; U; Android 13; zh-cn; 2210132C Build/TKQ1.221114.001) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/100.0.4896.127 Mobile Safari/537.36 XiaoMi/MiuiBrowser/17.4.40303 swan-mibrowser',
  openHarmony:
    'Mozilla/5.0 (Phone; OpenHarmony 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 ArkWeb/4.1.6.1 Mobile',
  pixel:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Mobile Safari/537.36',
  samsung:
    'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
  androidTablet:
    'Mozilla/5.0 (Linux; Android 12; SM-X906C) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
  androidWebView:
    'Mozilla/5.0 (Linux; Android 11; Redmi Note 9 Pro Build/RKQ1.200826.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.144 Mobile Safari/537.36',
  ie11: 'Mozilla/5.0 (Windows NT 6.1; WOW64; Trident/7.0; AS; rv:11.0) like Gecko',
  opera:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 OPR/105.0.0.0',
  chromeOS: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
  honor:
    'Mozilla/5.0 (Linux; Android 13; PGT-AN10 Build/HONORPGT-AN10; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/108.0.5359.128 Mobile Safari/537.36',
  smartTv: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/4.0 Chrome/76.0.3809.146 TV Safari/537.36',
}

describe('parseUA 桌面浏览器', () => {
  it('Chrome / Windows', () => {
    const r = parseUA(UA.chromeWin)
    expect(r.browser).toEqual({ name: 'Chrome', version: '120.0.0.0' })
    expect(r.engine).toEqual({ name: 'Blink', version: '120.0.0.0' })
    expect(r.os).toEqual({ name: 'Windows', version: '10 / 11' })
    expect(r.device).toEqual({ type: 'desktop', brand: null, model: null })
  })
  it('Edge（Chromium 与旧版 EdgeHTML）', () => {
    expect(parseUA(UA.edge).browser).toEqual({ name: 'Edge', version: '120.0.2210.91' })
    expect(parseUA(UA.edge).engine.name).toBe('Blink')
    const legacy = parseUA(UA.edgeLegacy)
    expect(legacy.browser).toEqual({ name: 'Edge', version: '18.19582' })
    expect(legacy.engine).toEqual({ name: 'EdgeHTML', version: '18.19582' })
  })
  it('Firefox：引擎版本取 rv', () => {
    const w = parseUA(UA.firefoxWin)
    expect(w.browser).toEqual({ name: 'Firefox', version: '121.0' })
    expect(w.engine).toEqual({ name: 'Gecko', version: '121.0' })
    const l = parseUA(UA.firefoxLinux)
    expect(l.browser.version).toBe('115.0')
    expect(l.engine.version).toBe('109.0')
    expect(l.os.name).toBe('Linux')
    expect(l.device.type).toBe('desktop')
  })
  it('Safari / macOS', () => {
    const r = parseUA(UA.safariMac)
    expect(r.browser).toEqual({ name: 'Safari', version: '17.2' })
    expect(r.engine).toEqual({ name: 'WebKit', version: '605.1.15' })
    expect(r.os).toEqual({ name: 'macOS', version: '10.15.7' })
    expect(r.device).toEqual({ type: 'desktop', brand: 'Apple', model: 'Mac' })
  })
  it('Opera、IE11、ChromeOS', () => {
    expect(parseUA(UA.opera).browser).toEqual({ name: 'Opera', version: '105.0.0.0' })
    const ie = parseUA(UA.ie11)
    expect(ie.browser).toEqual({ name: 'IE', version: '11.0' })
    expect(ie.engine).toEqual({ name: 'Trident', version: '7.0' })
    expect(ie.os).toEqual({ name: 'Windows', version: '7' })
    expect(parseUA(UA.chromeOS).os.name).toBe('ChromeOS')
  })
})

describe('parseUA iOS', () => {
  it('iPhone Safari', () => {
    const r = parseUA(UA.safariIPhone)
    expect(r.browser).toEqual({ name: 'Safari', version: '17.2' })
    expect(r.os).toEqual({ name: 'iOS', version: '17.2' })
    expect(r.device).toEqual({ type: 'mobile', brand: 'Apple', model: 'iPhone' })
  })
  it('iPad 上的 Chrome 引擎仍是 WebKit，系统叫 iPadOS', () => {
    const r = parseUA(UA.chromeIPad)
    expect(r.browser).toEqual({ name: 'Chrome', version: '120.0.6099.119' })
    expect(r.engine.name).toBe('WebKit')
    expect(r.os).toEqual({ name: 'iPadOS', version: '17.2' })
    expect(r.device.type).toBe('tablet')
  })
  it('iPad 旧系统（<13）仍叫 iOS', () => {
    const r = parseUA('Mozilla/5.0 (iPad; CPU OS 12_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1')
    expect(r.os.name).toBe('iOS')
  })
})

describe('parseUA 国内 App 与浏览器', () => {
  it('微信 Android：品牌取自型号', () => {
    const r = parseUA(UA.wechatAndroid)
    expect(r.browser).toEqual({ name: '微信', version: '8.0.43.2480' })
    expect(r.engine.name).toBe('Blink')
    expect(r.os).toEqual({ name: 'Android', version: '13' })
    expect(r.device).toEqual({ type: 'mobile', brand: '小米', model: '2201123C' })
  })
  it('微信 iOS', () => {
    const r = parseUA(UA.wechatIOS)
    expect(r.browser).toEqual({ name: '微信', version: '8.0.42' })
    expect(r.engine.name).toBe('WebKit')
    expect(r.os.version).toBe('16.6')
  })
  it('手机 QQ 优先于 QQ 浏览器内核', () => {
    const r = parseUA(UA.qqApp)
    expect(r.browser).toEqual({ name: '手机QQ', version: '8.9.50.10650' })
    expect(r.device).toEqual({ type: 'mobile', brand: 'OPPO', model: 'PEGM10' })
  })
  it('QQ 浏览器：忽略语言段取型号', () => {
    const r = parseUA(UA.qqBrowser)
    expect(r.browser).toEqual({ name: 'QQ浏览器', version: '13.1' })
    expect(r.device).toEqual({ type: 'mobile', brand: 'vivo', model: 'V2049A' })
  })
  it('UC 浏览器 + 华为机型', () => {
    const r = parseUA(UA.uc)
    expect(r.browser).toEqual({ name: 'UC浏览器', version: '13.4.0.1306' })
    expect(r.device).toEqual({ type: 'mobile', brand: '华为', model: 'ELE-AL00' })
  })
  it('华为浏览器 + HarmonyOS', () => {
    const r = parseUA(UA.huaweiBrowser)
    expect(r.browser).toEqual({ name: '华为浏览器', version: '13.0.5.303' })
    expect(r.os).toEqual({ name: 'HarmonyOS', version: null })
    expect(r.device).toEqual({ type: 'mobile', brand: '华为', model: 'NOH-AN00' })
  })
  it('小米浏览器', () => {
    const r = parseUA(UA.miBrowser)
    expect(r.browser).toEqual({ name: '小米浏览器', version: '17.4.40303' })
    expect(r.device.brand).toBe('小米')
    expect(r.device.model).toBe('2210132C')
  })
  it('OpenHarmony / ArkWeb', () => {
    const r = parseUA(UA.openHarmony)
    expect(r.browser.name).toBe('ArkWeb（鸿蒙内核）')
    expect(r.os).toEqual({ name: 'OpenHarmony', version: '5.0' })
    expect(r.device.type).toBe('mobile')
    expect(r.device.model).toBeNull()
  })
  it('荣耀机型有 HONOR 关键字时不误判华为', () => {
    expect(parseUA(UA.honor).device).toEqual({ type: 'mobile', brand: '荣耀', model: 'PGT-AN10' })
  })
})

describe('parseUA Android 其他', () => {
  it('Pixel / Chrome', () => {
    const r = parseUA(UA.pixel)
    expect(r.browser.name).toBe('Chrome')
    expect(r.os).toEqual({ name: 'Android', version: '14' })
    expect(r.device).toEqual({ type: 'mobile', brand: 'Google', model: 'Pixel 8' })
  })
  it('Samsung Internet', () => {
    const r = parseUA(UA.samsung)
    expect(r.browser).toEqual({ name: 'Samsung Internet', version: '23.0' })
    expect(r.device).toEqual({ type: 'mobile', brand: '三星', model: 'SM-S918B' })
  })
  it('没有 Mobile 的 Android 视为平板', () => {
    const r = parseUA(UA.androidTablet)
    expect(r.device).toEqual({ type: 'tablet', brand: '三星', model: 'SM-X906C' })
  })
  it('Android WebView 与红米', () => {
    const r = parseUA(UA.androidWebView)
    expect(r.browser).toEqual({ name: 'Android WebView', version: '120.0.6099.144' })
    expect(r.device).toEqual({ type: 'mobile', brand: '小米', model: 'Redmi Note 9 Pro' })
  })
  it('电视', () => {
    expect(parseUA(UA.smartTv).device.type).toBe('tv')
  })
  it('精简 UA 的型号 K 被忽略', () => {
    const r = parseUA('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36')
    expect(r.device.model).toBeNull()
    expect(r.device.type).toBe('mobile')
  })
})

describe('parseUA 边界', () => {
  it('空串与乱码都不抛错', () => {
    const empty = parseUA('')
    expect(empty.browser.name).toBeNull()
    expect(empty.engine.name).toBeNull()
    expect(empty.os.name).toBeNull()
    expect(empty.device).toEqual({ type: 'unknown', brand: null, model: null })
    expect(parseUA('   ').browser.name).toBeNull()
    expect(parseUA('curl/8.0.1').browser.name).toBeNull()
    expect(parseUA('???!!!').os.name).toBeNull()
  })
  it('Windows 旧版本号映射', () => {
    expect(parseUA('Mozilla/5.0 (Windows NT 6.3; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/80.0.0.0 Safari/537.36').os.version).toBe('8.1')
    expect(parseUA('Mozilla/5.0 (Windows NT 5.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/49.0.0.0 Safari/537.36').os.version).toBe('XP')
    expect(parseUA('Mozilla/5.0 (Windows NT 9.9) AppleWebKit/537.36 Chrome/80.0.0.0 Safari/537.36').os.version).toBe('9.9')
  })
  it('iOS App 内的 WebView（无 Safari 标记）', () => {
    const r = parseUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148')
    expect(r.browser.name).toBe('iOS WebView')
  })
})

describe('majorVersion / deviceTypeLabel', () => {
  it('主版本号', () => {
    expect(majorVersion('120.0.6099.144')).toBe('120')
    expect(majorVersion('17')).toBe('17')
    expect(majorVersion('')).toBeNull()
    expect(majorVersion(null)).toBeNull()
  })
  it('设备类型中文名', () => {
    expect(deviceTypeLabel('mobile')).toBe('手机')
    expect(deviceTypeLabel('tablet')).toBe('平板')
    expect(deviceTypeLabel('desktop')).toBe('桌面电脑')
    expect(deviceTypeLabel('tv')).toBe('电视')
    expect(deviceTypeLabel('unknown')).toBe('未知')
  })
})
