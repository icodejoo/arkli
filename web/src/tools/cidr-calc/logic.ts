// CIDR 计算：IPv4 全套（网络/广播/掩码/可用主机/子网划分/包含判断），IPv6 做前缀展开与范围（BigInt）

/** IPv4 一个网段块的信息 */
export interface IPv4Block {
  /** 网络地址 */
  network: string
  /** 广播地址 */
  broadcast: string
  /** 首个可用主机 */
  first: string
  /** 末个可用主机 */
  last: string
  /** 可用主机数 */
  hosts: number
}

/** IPv4 计算结果 */
export interface IPv4Result extends IPv4Block {
  /** 固定为 4 */
  version: 4
  /** 输入的 IP */
  ip: string
  /** 前缀长度 0~32 */
  prefix: number
  /** 子网掩码 */
  mask: string
  /** 反掩码 */
  wildcard: string
  /** 地址总数（含网络、广播） */
  total: number
  /** 二进制展示（点分，每段 8 位） */
  binary: { ip: string; mask: string; network: string }
  /** 地址用途说明，如 "私网地址" */
  kind: string
  /** 经典分类 A~E */
  ipClass: string
}

/** IPv6 计算结果 */
export interface IPv6Result {
  /** 固定为 6 */
  version: 6
  /** 输入地址的压缩写法 */
  ip: string
  /** 输入地址的完整展开写法 */
  expanded: string
  /** 前缀长度 0~128 */
  prefix: number
  /** 网络地址（压缩写法） */
  network: string
  /** 起始地址（展开写法） */
  first: string
  /** 结束地址（展开写法） */
  last: string
  /** 地址总数（十进制字符串，可能很大） */
  total: string
  /** 若是 IPv4 映射地址（::ffff:a.b.c.d），这里给出 IPv4 部分 */
  mappedIPv4: string | null
}

/** IPv4 位数 */
const V4_BITS = 32
/** IPv6 位数 */
const V6_BITS = 128
/** IPv6 组数 */
const V6_GROUPS = 8
/** 每个 IPv6 组位数 */
const V6_GROUP_BITS = 16
/** 子网划分最多列出的条数 */
export const MAX_SPLIT_LIST = 256
/** 32 位全 1 */
const ALL_ONES = 0xffffffff

/** 特殊用途 IPv4 网段表：[网络地址, 前缀, 说明]，前面的优先匹配 */
const V4_KINDS: Array<[string, number, string]> = [
  ['255.255.255.255', 32, '受限广播地址'],
  ['0.0.0.0', 8, '本网络（"这台主机"）'],
  ['10.0.0.0', 8, '私网地址'],
  ['100.64.0.0', 10, '运营商级 NAT 共享地址'],
  ['127.0.0.0', 8, '回环地址'],
  ['169.254.0.0', 16, '链路本地地址'],
  ['172.16.0.0', 12, '私网地址'],
  ['192.0.0.0', 24, 'IETF 协议保留'],
  ['192.0.2.0', 24, '文档示例地址（TEST-NET-1）'],
  ['192.168.0.0', 16, '私网地址'],
  ['198.18.0.0', 15, '性能测试保留'],
  ['198.51.100.0', 24, '文档示例地址（TEST-NET-2）'],
  ['203.0.113.0', 24, '文档示例地址（TEST-NET-3）'],
  ['224.0.0.0', 4, '组播地址'],
  ['240.0.0.0', 4, '保留地址'],
]

/**
 * 解析点分十进制 IPv4。严格要求 4 段、每段 0~255 的十进制数，不接受前导 0。
 *
 * @param s 如 "192.168.1.1"
 * @returns 无符号 32 位整数；格式不对返回 null
 * @example
 * parseIPv4('192.168.1.1') // 3232235777
 * parseIPv4('256.1.1.1')   // null
 */
export function parseIPv4(s: string): number | null {
  const parts = s.trim().split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return null
    const v = Number(p)
    if (v > 255) return null
    n = n * 256 + v
  }
  return n
}

/**
 * 无符号 32 位整数转点分十进制。
 *
 * @param n 0 ~ 4294967295
 * @returns 如 "10.0.0.1"
 * @example
 * formatIPv4(3232235777) // "192.168.1.1"
 */
export function formatIPv4(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
}

/**
 * 前缀长度转掩码整数。
 *
 * @param prefix 0~32
 * @returns 无符号 32 位掩码；越界抛 RangeError
 * @example
 * prefixToMask(24) // 4294967040（255.255.255.0）
 */
export function prefixToMask(prefix: number): number {
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > V4_BITS) throw new RangeError('IPv4 前缀长度须在 0 到 32 之间')
  return prefix === 0 ? 0 : (ALL_ONES << (V4_BITS - prefix)) >>> 0
}

/**
 * 掩码转前缀长度，要求掩码是连续的 1 后接连续的 0。
 *
 * @param mask 无符号 32 位掩码
 * @returns 前缀长度；不连续返回 null
 * @example
 * maskToPrefix(parseIPv4('255.255.255.0')!) // 24
 * maskToPrefix(parseIPv4('255.0.255.0')!)   // null
 */
export function maskToPrefix(mask: number): number | null {
  for (let p = 0; p <= V4_BITS; p++) if (prefixToMask(p) === mask >>> 0) return p
  return null
}

/** 整数转 8 位一组的点分二进制 */
function toBinary(n: number): string {
  return [24, 16, 8, 0].map((sh) => ((n >>> sh) & 255).toString(2).padStart(8, '0')).join('.')
}

/** 判断 IP 是否落在 [网络, 前缀] 内 */
function inNet(ip: number, net: number, prefix: number): boolean {
  const m = prefixToMask(prefix)
  return ((ip & m) >>> 0) === ((net & m) >>> 0)
}

/**
 * 说明一个 IPv4 地址的用途（私网、回环、组播等）。
 *
 * @param ip 无符号 32 位整数
 * @returns 中文说明，普通地址为 "公网地址"
 * @example
 * describeIPv4(parseIPv4('10.1.2.3')!) // "私网地址"
 */
export function describeIPv4(ip: number): string {
  for (const [net, p, label] of V4_KINDS) if (inNet(ip, parseIPv4(net)!, p)) return label
  return '公网地址'
}

/** 按首字节判断经典 A~E 类 */
function classOfIPv4(ip: number): string {
  const b = ip >>> 24
  if (b < 128) return 'A'
  if (b < 192) return 'B'
  if (b < 224) return 'C'
  if (b < 240) return 'D'
  return 'E'
}

/** 由网络整数和前缀算出块信息；/31 两个地址都可用（RFC 3021），/32 只有自己 */
function blockOf(network: number, prefix: number): IPv4Block {
  const mask = prefixToMask(prefix)
  const net = (network & mask) >>> 0
  const bc = (net | (~mask >>> 0)) >>> 0
  if (prefix === V4_BITS) return { network: formatIPv4(net), broadcast: formatIPv4(net), first: formatIPv4(net), last: formatIPv4(net), hosts: 1 }
  if (prefix === V4_BITS - 1) return { network: formatIPv4(net), broadcast: formatIPv4(bc), first: formatIPv4(net), last: formatIPv4(bc), hosts: 2 }
  return {
    network: formatIPv4(net),
    broadcast: formatIPv4(bc),
    first: formatIPv4(net + 1),
    last: formatIPv4(bc - 1),
    hosts: Math.pow(2, V4_BITS - prefix) - 2,
  }
}

/** 解析 "掩码部分"：纯数字是前缀，含点是点分掩码 */
function parseMaskPart(s: string): number {
  if (/^\d+$/.test(s)) {
    const p = Number(s)
    if (p > V4_BITS) throw new RangeError('IPv4 前缀长度须在 0 到 32 之间')
    return p
  }
  const m = parseIPv4(s)
  if (m === null) throw new Error('掩码格式不对')
  const p = maskToPrefix(m)
  if (p === null) throw new Error('子网掩码必须是连续的 1 后面跟连续的 0')
  return p
}

/**
 * 解析并计算 IPv4 网段。支持 "ip/前缀"、"ip/掩码"、"ip 掩码"、单个 "ip"（按 /32）。
 *
 * @param text 用户输入
 * @returns 计算结果；格式不合法时抛 Error（message 为中文提示）
 * @example
 * const r = calcIPv4('192.168.1.130/26')
 * r.network // "192.168.1.128"
 * r.broadcast // "192.168.1.191"
 * r.hosts // 62
 */
export function calcIPv4(text: string): IPv4Result {
  const parts = text.trim().split(/\s*\/\s*|\s+/)
  if (parts.length > 2 || parts[0] === '') throw new Error('请输入 IPv4，如 192.168.1.0/24')
  const ip = parseIPv4(parts[0])
  if (ip === null) throw new Error('IPv4 地址格式不对')
  const prefix = parts.length === 2 ? parseMaskPart(parts[1]) : V4_BITS
  const mask = prefixToMask(prefix)
  const block = blockOf(ip, prefix)
  return {
    version: 4,
    ip: formatIPv4(ip),
    prefix,
    mask: formatIPv4(mask),
    wildcard: formatIPv4(~mask >>> 0),
    total: Math.pow(2, V4_BITS - prefix),
    binary: { ip: toBinary(ip), mask: toBinary(mask), network: toBinary((ip & mask) >>> 0) },
    kind: describeIPv4(ip),
    ipClass: classOfIPv4(ip),
    ...block,
  }
}

/**
 * 判断 IP 是否在某个网段内。
 *
 * @param cidr 网段，如 "10.0.0.0/8"（也接受 "ip 掩码"）
 * @param ip 待判断的 IPv4
 * @returns 在网段内返回 true；任一输入格式不对抛 Error
 * @example
 * ipInCidr('192.168.1.0/24', '192.168.1.77') // true
 */
export function ipInCidr(cidr: string, ip: string): boolean {
  const r = calcIPv4(cidr)
  const n = parseIPv4(ip)
  if (n === null) throw new Error('待判断的 IP 格式不对')
  return inNet(n, parseIPv4(r.network)!, r.prefix)
}

/**
 * 把网段拆成更小的子网。
 *
 * @param cidr 父网段，如 "192.168.1.0/24"
 * @param newPrefix 子网前缀长度，须不小于父前缀且不超过 32
 * @returns count 为子网总数，subnets 最多列出 MAX_SPLIT_LIST 个；前缀不合法抛 RangeError
 * @example
 * splitSubnet('192.168.1.0/24', 26).count // 4
 */
export function splitSubnet(cidr: string, newPrefix: number): { count: number; subnets: IPv4Block[] } {
  const r = calcIPv4(cidr)
  if (!Number.isInteger(newPrefix) || newPrefix < r.prefix || newPrefix > V4_BITS) {
    throw new RangeError(`子网前缀须在 ${r.prefix} 到 32 之间`)
  }
  const count = Math.pow(2, newPrefix - r.prefix)
  const step = Math.pow(2, V4_BITS - newPrefix)
  const base = parseIPv4(r.network)!
  const subnets: IPv4Block[] = []
  for (let i = 0; i < Math.min(count, MAX_SPLIT_LIST); i++) subnets.push(blockOf(base + i * step, newPrefix))
  return { count, subnets }
}

// ============ IPv6 ============

/** 16 位一组的最大值 */
const GROUP_MAX = 0xffff
/** 128 位全 1 */
const V6_ALL_ONES = (BigInt(1) << BigInt(V6_BITS)) - BigInt(1)

/**
 * 解析 IPv6（支持 "::" 压缩与末尾内嵌 IPv4，如 ::ffff:1.2.3.4；不支持 %zone）。
 *
 * @param s 地址文本
 * @returns 128 位 BigInt；格式不对返回 null
 * @example
 * parseIPv6('::1') // 1n
 */
export function parseIPv6(s: string): bigint | null {
  let t = s.trim()
  if (!t || /[^0-9a-fA-F:.]/.test(t)) return null
  if (t.indexOf('.') >= 0) {
    const i = t.lastIndexOf(':')
    const v4 = i < 0 ? null : parseIPv4(t.slice(i + 1))
    if (v4 === null) return null
    t = `${t.slice(0, i + 1)}${(v4 >>> 16).toString(16)}:${(v4 & GROUP_MAX).toString(16)}`
  }
  const dbl = t.split('::')
  if (dbl.length > 2) return null
  const head = dbl[0] ? dbl[0].split(':') : []
  const tail = dbl.length === 2 && dbl[1] ? dbl[1].split(':') : []
  let groups: string[]
  if (dbl.length === 1) {
    if (head.length !== V6_GROUPS) return null
    groups = head
  } else {
    const fill = V6_GROUPS - head.length - tail.length
    if (fill < 1) return null
    groups = [...head, ...new Array<string>(fill).fill('0'), ...tail]
  }
  let n = BigInt(0)
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
    n = (n << BigInt(V6_GROUP_BITS)) | BigInt(parseInt(g, 16))
  }
  return n
}

/** BigInt 拆成 8 个 16 位数 */
function toGroups(n: bigint): number[] {
  const out: number[] = []
  for (let i = V6_GROUPS - 1; i >= 0; i--) out.push(Number((n >> BigInt(i * V6_GROUP_BITS)) & BigInt(GROUP_MAX)))
  return out
}

/**
 * 格式化成完整展开写法（8 组 4 位小写十六进制）。
 *
 * @param n 128 位 BigInt
 * @returns 如 "2001:0db8:0000:0000:0000:0000:0000:0001"
 * @example
 * expandIPv6(1n) // "0000:0000:0000:0000:0000:0000:0000:0001"
 */
export function expandIPv6(n: bigint): string {
  return toGroups(n).map((g) => g.toString(16).padStart(4, '0')).join(':')
}

/**
 * 格式化成 RFC 5952 压缩写法：小写，去前导 0，最长的连续 0 组（至少 2 组）用 "::"。
 *
 * @param n 128 位 BigInt
 * @returns 如 "2001:db8::1"
 * @example
 * compressIPv6(1n) // "::1"
 */
export function compressIPv6(n: bigint): string {
  const g = toGroups(n)
  let bestStart = -1
  let bestLen = 0
  for (let i = 0; i < g.length; ) {
    if (g[i] !== 0) {
      i++
      continue
    }
    let j = i
    while (j < g.length && g[j] === 0) j++
    if (j - i > bestLen) {
      bestStart = i
      bestLen = j - i
    }
    i = j
  }
  const hex = g.map((x) => x.toString(16))
  if (bestLen < 2) return hex.join(':')
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLen).join(':')}`
}

/**
 * 解析并计算 IPv6 前缀（只做展开与范围）。
 *
 * @param text 如 "2001:db8::/32"，不写前缀按 /128
 * @returns 计算结果；格式不对或前缀越界时抛 Error
 * @example
 * const r = calcIPv6('2001:db8::/32')
 * r.network // "2001:db8::"
 * r.total   // "79228162514264337593543950336"
 */
export function calcIPv6(text: string): IPv6Result {
  const parts = text.trim().split(/\s*\/\s*/)
  if (parts.length > 2 || parts[0] === '') throw new Error('请输入 IPv6，如 2001:db8::/32')
  const ip = parseIPv6(parts[0])
  if (ip === null) throw new Error('IPv6 地址格式不对')
  let prefix = V6_BITS
  if (parts.length === 2) {
    if (!/^\d+$/.test(parts[1]) || Number(parts[1]) > V6_BITS) throw new RangeError('IPv6 前缀长度须在 0 到 128 之间')
    prefix = Number(parts[1])
  }
  const hostBits = BigInt(V6_BITS - prefix)
  const hostMask = (BigInt(1) << hostBits) - BigInt(1)
  const net = ip & (V6_ALL_ONES ^ hostMask)
  // ::ffff:0:0/96：高 96 位恰为 0000…0000ffff
  const isMapped = ip >> BigInt(V4_BITS) === BigInt(GROUP_MAX)
  return {
    version: 6,
    ip: compressIPv6(ip),
    expanded: expandIPv6(ip),
    prefix,
    network: compressIPv6(net),
    first: expandIPv6(net),
    last: expandIPv6(net | hostMask),
    total: (BigInt(1) << hostBits).toString(),
    mappedIPv4: isMapped ? formatIPv4(Number(ip & BigInt(ALL_ONES))) : null,
  }
}

/**
 * 自动识别 IPv4 / IPv6 并计算（含冒号视为 IPv6）。
 *
 * @param text 用户输入
 * @returns IPv4 或 IPv6 的结果；格式不对抛 Error
 * @example
 * calcCidr('10.0.0.0/8').version // 4
 * calcCidr('::1/128').version    // 6
 */
export function calcCidr(text: string): IPv4Result | IPv6Result {
  return text.indexOf(':') >= 0 ? calcIPv6(text) : calcIPv4(text)
}
