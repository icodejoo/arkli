import { describe, expect, it } from 'vitest'
import {
  calcCidr,
  calcIPv4,
  calcIPv6,
  compressIPv6,
  describeIPv4,
  expandIPv6,
  formatIPv4,
  ipInCidr,
  maskToPrefix,
  MAX_SPLIT_LIST,
  parseIPv4,
  parseIPv6,
  prefixToMask,
  splitSubnet,
} from './logic'

describe('parseIPv4 / formatIPv4', () => {
  it('正常往返', () => {
    expect(parseIPv4('192.168.1.1')).toBe(3232235777)
    expect(parseIPv4('0.0.0.0')).toBe(0)
    expect(parseIPv4('255.255.255.255')).toBe(4294967295)
    expect(formatIPv4(3232235777)).toBe('192.168.1.1')
    expect(formatIPv4(4294967295)).toBe('255.255.255.255')
  })
  it('非法输入返回 null', () => {
    for (const s of ['', '1.2.3', '1.2.3.4.5', '256.1.1.1', '01.2.3.4', 'a.b.c.d', '1.2.3.-4', '1..2.3']) {
      expect(parseIPv4(s)).toBeNull()
    }
  })
})

describe('prefixToMask / maskToPrefix', () => {
  it('边界前缀', () => {
    expect(prefixToMask(0)).toBe(0)
    expect(prefixToMask(24)).toBe(0xffffff00)
    expect(prefixToMask(32)).toBe(0xffffffff)
    expect(formatIPv4(prefixToMask(20))).toBe('255.255.240.0')
  })
  it('越界抛错', () => {
    expect(() => prefixToMask(-1)).toThrow(RangeError)
    expect(() => prefixToMask(33)).toThrow(RangeError)
    expect(() => prefixToMask(1.5)).toThrow(RangeError)
  })
  it('掩码转前缀，不连续返回 null', () => {
    expect(maskToPrefix(parseIPv4('255.255.255.0')!)).toBe(24)
    expect(maskToPrefix(0)).toBe(0)
    expect(maskToPrefix(parseIPv4('255.0.255.0')!)).toBeNull()
  })
})

describe('calcIPv4', () => {
  it('/26 网段', () => {
    const r = calcIPv4('192.168.1.130/26')
    expect(r).toMatchObject({
      version: 4,
      network: '192.168.1.128',
      broadcast: '192.168.1.191',
      mask: '255.255.255.192',
      wildcard: '0.0.0.63',
      first: '192.168.1.129',
      last: '192.168.1.190',
      hosts: 62,
      total: 64,
      prefix: 26,
      kind: '私网地址',
      ipClass: 'C',
    })
    expect(r.binary.mask).toBe('11111111.11111111.11111111.11000000')
    expect(r.binary.network).toBe('11000000.10101000.00000001.10000000')
  })
  it('接受点分掩码和空格分隔', () => {
    expect(calcIPv4('10.0.0.5/255.0.0.0').prefix).toBe(8)
    expect(calcIPv4('10.0.0.5 255.255.0.0').network).toBe('10.0.0.0')
  })
  it('/0', () => {
    const r = calcIPv4('1.2.3.4/0')
    expect(r.network).toBe('0.0.0.0')
    expect(r.broadcast).toBe('255.255.255.255')
    expect(r.total).toBe(4294967296)
    expect(r.hosts).toBe(4294967294)
  })
  it('/31 两个地址都可用，/32 只有自己', () => {
    const a = calcIPv4('10.0.0.2/31')
    expect([a.first, a.last, a.hosts]).toEqual(['10.0.0.2', '10.0.0.3', 2])
    const b = calcIPv4('10.0.0.7/32')
    expect([b.first, b.last, b.network, b.broadcast, b.hosts]).toEqual(['10.0.0.7', '10.0.0.7', '10.0.0.7', '10.0.0.7', 1])
  })
  it('不写前缀按 /32', () => {
    expect(calcIPv4('8.8.8.8').prefix).toBe(32)
  })
  it('错误输入给出中文提示', () => {
    expect(() => calcIPv4('')).toThrow('请输入')
    expect(() => calcIPv4('1.2.3/24')).toThrow('格式不对')
    expect(() => calcIPv4('1.2.3.4/33')).toThrow(RangeError)
    expect(() => calcIPv4('1.2.3.4/255.0.255.0')).toThrow('连续')
    expect(() => calcIPv4('1.2.3.4/abc')).toThrow('掩码')
    expect(() => calcIPv4('1.2.3.4/24/5')).toThrow()
  })
})

describe('describeIPv4', () => {
  it('特殊地址识别', () => {
    const d = (s: string) => describeIPv4(parseIPv4(s)!)
    expect(d('10.1.2.3')).toBe('私网地址')
    expect(d('172.31.255.1')).toBe('私网地址')
    expect(d('172.32.0.1')).toBe('公网地址')
    expect(d('127.0.0.1')).toBe('回环地址')
    expect(d('169.254.1.1')).toBe('链路本地地址')
    expect(d('100.64.0.1')).toBe('运营商级 NAT 共享地址')
    expect(d('224.0.0.1')).toBe('组播地址')
    expect(d('255.255.255.255')).toBe('受限广播地址')
    expect(d('8.8.8.8')).toBe('公网地址')
  })
})

describe('ipInCidr', () => {
  it('包含判断', () => {
    expect(ipInCidr('192.168.1.0/24', '192.168.1.77')).toBe(true)
    expect(ipInCidr('192.168.1.0/24', '192.168.2.1')).toBe(false)
    expect(ipInCidr('0.0.0.0/0', '8.8.8.8')).toBe(true)
    expect(ipInCidr('10.0.0.1/32', '10.0.0.1')).toBe(true)
    expect(ipInCidr('10.0.0.1/32', '10.0.0.2')).toBe(false)
  })
  it('IP 格式不对抛错', () => {
    expect(() => ipInCidr('10.0.0.0/8', 'x')).toThrow('待判断')
  })
})

describe('splitSubnet', () => {
  it('/24 拆成 4 个 /26', () => {
    const { count, subnets } = splitSubnet('192.168.1.0/24', 26)
    expect(count).toBe(4)
    expect(subnets.map((s) => s.network)).toEqual(['192.168.1.0', '192.168.1.64', '192.168.1.128', '192.168.1.192'])
    expect(subnets[3].broadcast).toBe('192.168.1.255')
    expect(subnets[0].hosts).toBe(62)
  })
  it('前缀相同返回自己', () => {
    expect(splitSubnet('10.0.0.0/24', 24).count).toBe(1)
  })
  it('结果过多时只列前 MAX_SPLIT_LIST 条，但 count 完整', () => {
    const r = splitSubnet('10.0.0.0/8', 24)
    expect(r.count).toBe(65536)
    expect(r.subnets).toHaveLength(MAX_SPLIT_LIST)
  })
  it('非法前缀抛错', () => {
    expect(() => splitSubnet('10.0.0.0/24', 23)).toThrow(RangeError)
    expect(() => splitSubnet('10.0.0.0/24', 33)).toThrow(RangeError)
    expect(() => splitSubnet('10.0.0.0/24', 25.5)).toThrow(RangeError)
  })
})

describe('parseIPv6 / expandIPv6 / compressIPv6', () => {
  it('压缩与展开往返', () => {
    expect(parseIPv6('::1')).toBe(BigInt(1))
    expect(parseIPv6('::')).toBe(BigInt(0))
    expect(expandIPv6(parseIPv6('2001:db8::1')!)).toBe('2001:0db8:0000:0000:0000:0000:0000:0001')
    expect(compressIPv6(parseIPv6('2001:0db8:0000:0000:0000:0000:0000:0001')!)).toBe('2001:db8::1')
  })
  it('压缩规则：最长零段、至少两组、单个零不压', () => {
    expect(compressIPv6(parseIPv6('2001:db8:0:0:1:0:0:1')!)).toBe('2001:db8::1:0:0:1')
    expect(compressIPv6(parseIPv6('2001:db8:0:1:1:1:1:1')!)).toBe('2001:db8:0:1:1:1:1:1')
    expect(compressIPv6(BigInt(0))).toBe('::')
    expect(compressIPv6(parseIPv6('1::')!)).toBe('1::')
  })
  it('内嵌 IPv4', () => {
    expect(parseIPv6('::ffff:1.2.3.4')).toBe(parseIPv6('::ffff:102:304'))
  })
  it('非法输入返回 null', () => {
    for (const s of ['', ':::', '1::2::3', '12345::', 'g::1', '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9', '::1.2.3', ':1::', 'fe80::1%eth0']) {
      expect(parseIPv6(s)).toBeNull()
    }
  })
  it('8 组满写合法', () => {
    expect(parseIPv6('1:2:3:4:5:6:7:8')).not.toBeNull()
  })
})

describe('calcIPv6', () => {
  it('/32 前缀展开与范围', () => {
    const r = calcIPv6('2001:db8:abcd::1/32')
    expect(r.network).toBe('2001:db8::')
    expect(r.first).toBe('2001:0db8:0000:0000:0000:0000:0000:0000')
    expect(r.last).toBe('2001:0db8:ffff:ffff:ffff:ffff:ffff:ffff')
    expect(r.total).toBe('79228162514264337593543950336')
    expect(r.prefix).toBe(32)
  })
  it('/128 与 /127、/0 边界', () => {
    expect(calcIPv6('::1').total).toBe('1')
    expect(calcIPv6('::1/128').prefix).toBe(128)
    expect(calcIPv6('2001:db8::1/127').total).toBe('2')
    const all = calcIPv6('::1/0')
    expect(all.total).toBe('340282366920938463463374607431768211456')
    expect(all.last).toBe('ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')
  })
  it('识别 IPv4 映射地址', () => {
    expect(calcIPv6('::ffff:1.2.3.4').mappedIPv4).toBe('1.2.3.4')
    expect(calcIPv6('2001:db8::1').mappedIPv4).toBeNull()
  })
  it('非法输入', () => {
    expect(() => calcIPv6('')).toThrow('请输入')
    expect(() => calcIPv6('zz::1')).toThrow('格式不对')
    expect(() => calcIPv6('::1/129')).toThrow(RangeError)
    expect(() => calcIPv6('::1/x')).toThrow(RangeError)
  })
})

describe('calcCidr', () => {
  it('按冒号自动区分版本', () => {
    expect(calcCidr('10.0.0.0/8').version).toBe(4)
    expect(calcCidr('::1/128').version).toBe(6)
  })
})
