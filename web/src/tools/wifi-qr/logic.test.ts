import { describe, expect, it } from 'vitest'
import { AUTH_OPTIONS, buildWifiPayload, escapeWifi, validateWifi, type WifiInput } from './logic'

/** 构造输入的小工具 */
const mk = (p: Partial<WifiInput>): WifiInput => ({ ssid: 'home', password: '12345678', auth: 'WPA', hidden: false, ...p })

describe('escapeWifi', () => {
  it('转义五种特殊字符', () => {
    expect(escapeWifi('\\;,:"')).toBe('\\\\\\;\\,\\:\\"')
  })
  it('普通字符不变', () => {
    expect(escapeWifi('我的WiFi_5G')).toBe('我的WiFi_5G')
  })
})

describe('buildWifiPayload', () => {
  it('WPA 基本格式', () => {
    expect(buildWifiPayload(mk({}))).toBe('WIFI:T:WPA;S:home;P:12345678;H:false;;')
  })
  it('隐藏网络', () => {
    expect(buildWifiPayload(mk({ hidden: true }))).toBe('WIFI:T:WPA;S:home;P:12345678;H:true;;')
  })
  it('无密码省略 P', () => {
    expect(buildWifiPayload(mk({ auth: 'nopass', password: 'x' }))).toBe('WIFI:T:nopass;S:home;H:false;;')
  })
  it('WEP', () => {
    expect(buildWifiPayload(mk({ auth: 'WEP', password: 'abc' }))).toBe('WIFI:T:WEP;S:home;P:abc;H:false;;')
  })
  it('特殊字符被转义', () => {
    expect(buildWifiPayload(mk({ ssid: 'a;b', password: 'p:w,"\\x1' }))).toBe('WIFI:T:WPA;S:a\\;b;P:p\\:w\\,\\"\\\\x1;H:false;;')
  })
  it('纯十六进制 SSID 加引号', () => {
    expect(buildWifiPayload(mk({ ssid: 'abcd' }))).toContain('S:"abcd";')
  })
})

describe('validateWifi', () => {
  it('通过', () => {
    expect(validateWifi(mk({}))).toBe('')
  })
  it('缺名称', () => {
    expect(validateWifi(mk({ ssid: '' }))).toContain('名称')
  })
  it('名称超 32 字节', () => {
    expect(validateWifi(mk({ ssid: '网'.repeat(11) }))).toContain('32')
    expect(validateWifi(mk({ ssid: '网'.repeat(10) }))).toBe('')
  })
  it('WPA 密码长度', () => {
    expect(validateWifi(mk({ password: '1234567' }))).toContain('8')
    expect(validateWifi(mk({ password: 'a'.repeat(64) }))).toContain('63')
  })
  it('WEP 需要密码，无密码类型不检查', () => {
    expect(validateWifi(mk({ auth: 'WEP', password: '' }))).toContain('WEP')
    expect(validateWifi(mk({ auth: 'nopass', password: '' }))).toBe('')
  })
})

describe('AUTH_OPTIONS', () => {
  it('覆盖三种类型', () => {
    expect(AUTH_OPTIONS.map((o) => o.id)).toEqual(['WPA', 'WEP', 'nopass'])
  })
})
