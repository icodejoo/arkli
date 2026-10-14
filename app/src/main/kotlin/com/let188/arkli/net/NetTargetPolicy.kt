package com.let188.arkli.net

import java.net.Inet4Address
import java.net.InetAddress

/**
 * 联网目标校验（SSRF 纵深防御）：判断主机名与解析出的地址能不能被 `native.net.*` 访问。
 * 全是纯函数，真正的 DNS 解析通过 [Resolver] 注入，JVM 单测可直接跑。
 *
 * 已知局限：校验时解析一次，`HttpURLConnection` 连接时会再解析一次，
 * DNS 重绑定（两次解析结果不同）无法在这一层完全消除。
 * 威胁模型是「本地 App、用户自己输入网址」，这里是纵深防御，不是安全边界。
 */
object NetTargetPolicy {
    /** 校验不通过时统一的提示文案 */
    const val DENIED_MESSAGE = "目标地址不允许"

    /** 主机名最大长度 */
    const val MAX_HOST_LENGTH = 253

    /** 单个标签最大长度 */
    private const val MAX_LABEL_LENGTH = 63

    /** IPv4 字节数 */
    private const val V4_BYTES = 4

    /** IPv6 字节数 */
    private const val V6_BYTES = 16

    /** IPv4 映射 / NAT64 前缀之后内嵌 v4 的起始下标 */
    private const val V6_EMBED_OFFSET = 12

    /** 一个字节的掩码 */
    private const val BYTE_MASK = 0xFF

    /** 直接拒绝的主机名（精确匹配） */
    private val BLOCKED_NAMES = setOf("localhost", "ip6-localhost", "ip6-loopback")

    /** 直接拒绝的主机名后缀（内网常见域） */
    private val BLOCKED_SUFFIXES = listOf(
        ".localhost", ".local", ".internal", ".localdomain", ".lan", ".home.arpa", ".intranet", ".corp",
    )

    /** 点分十进制 IPv4 */
    private val IPV4_REGEX = Regex("""^\d{1,3}(\.\d{1,3}){3}$""")

    /** 主机名标签：字母数字开头结尾，中间允许连字符与下划线 */
    private val LABEL_REGEX = Regex("""^[A-Za-z0-9]([A-Za-z0-9_-]*[A-Za-z0-9])?$""")

    /** IPv6 字面量允许的字符 */
    private val IPV6_CHARS = Regex("""^[0-9A-Fa-f:.]+$""")

    /**
     * 去掉 IPv6 字面量外面的方括号与主机名结尾的点，并转小写。
     *
     * @param host 原始主机
     * @return 归一化后的主机
     */
    fun normalizeHost(host: String): String =
        host.trim().removePrefix("[").removeSuffix("]").trimEnd('.').lowercase()

    /**
     * 判断是不是 IP 字面量（点分 IPv4 或含冒号的 IPv6）。
     *
     * @param host 已归一化的主机
     * @return 是 IP 字面量为 true
     */
    fun isIpLiteral(host: String): Boolean =
        IPV4_REGEX.matches(host) || (host.contains(':') && IPV6_CHARS.matches(host))

    /**
     * 判断主机格式是否合法：IP 字面量或由合法标签组成的域名，长度不超过 253。
     *
     * @param host 主机（可带 IPv6 方括号）
     * @return 合法为 true
     * 示例：`isValidHost("example.com")` 为 true，`isValidHost("a b")` 为 false
     */
    fun isValidHost(host: String): Boolean {
        val h = normalizeHost(host)
        if (h.isEmpty() || h.length > MAX_HOST_LENGTH) return false
        if (isIpLiteral(h)) return true
        return h.split('.').all { it.isNotEmpty() && it.length <= MAX_LABEL_LENGTH && LABEL_REGEX.matches(it) }
    }

    /**
     * 主机名本身是否就该拒绝：`localhost`、`.local`、`.internal` 等，以及不含点的单标签名（内网短名）。
     * IP 字面量不在这里判断，交给 [isBlockedAddress]。
     *
     * @param host 主机
     * @return 应拒绝为 true
     */
    fun isBlockedHostName(host: String): Boolean {
        val h = normalizeHost(host)
        if (isIpLiteral(h)) return false
        if (h in BLOCKED_NAMES) return true
        if (BLOCKED_SUFFIXES.any { h.endsWith(it) }) return true
        return !h.contains('.')
    }

    /**
     * 判断一个地址是否落在禁止范围内。
     * IPv4：0/8、10/8、100.64/10、127/8、169.254/16、172.16/12、192.168/16、224/4、240/4（含广播）。
     * IPv6：`::`、`::1`、fc00::/7、fe80::/10、ff00::/8，以及 IPv4 映射 / 兼容 / NAT64 前缀按内嵌 v4 判断。
     *
     * @param address 解析出的地址
     * @return 应拒绝为 true
     */
    fun isBlockedAddress(address: InetAddress): Boolean {
        val b = address.address
        return when (b.size) {
            V4_BYTES -> isBlockedV4(b, 0)
            V6_BYTES -> isBlockedV6(b)
            else -> true
        }
    }

    /** 判断 IPv4 字节（从 [off] 起 4 字节）是否被禁 */
    private fun isBlockedV4(b: ByteArray, off: Int): Boolean {
        val a = b[off].toInt() and BYTE_MASK
        val c = b[off + 1].toInt() and BYTE_MASK
        return when {
            a == 0 || a == 10 || a == 127 -> true
            a == 100 && c in 64..127 -> true
            a == 169 && c == 254 -> true
            a == 172 && c in 16..31 -> true
            a == 192 && c == 168 -> true
            a >= 224 -> true
            else -> false
        }
    }

    /** 判断 IPv6 字节是否被禁 */
    private fun isBlockedV6(b: ByteArray): Boolean {
        val first = b[0].toInt() and BYTE_MASK
        val second = b[1].toInt() and BYTE_MASK
        if ((first and 0xFE) == 0xFC) return true
        if (first == 0xFE && (second and 0xC0) == 0x80) return true
        if (first == 0xFF) return true
        if (embedsV4(b)) return isBlockedV4(b, V6_EMBED_OFFSET)
        return false
    }

    /** 是否是「前 96 位为 0 / ::ffff / 64:ff9b」这类内嵌 v4 的地址（:: 与 ::1 也落在前 96 位为 0 里） */
    private fun embedsV4(b: ByteArray): Boolean {
        val zeros = (0 until 10).all { b[it].toInt() == 0 }
        val mappedOrCompat = zeros && ((b[10].toInt() == -1 && b[11].toInt() == -1) || (b[10].toInt() == 0 && b[11].toInt() == 0))
        val nat64 = b[0].toInt() == 0x00 && b[1].toInt() == 0x64 && (b[2].toInt() and BYTE_MASK) == 0xFF &&
            (b[3].toInt() and BYTE_MASK) == 0x9B && (4 until V6_EMBED_OFFSET).all { b[it].toInt() == 0 }
        return mappedOrCompat || nat64
    }

    /**
     * 检查一组解析结果：只要有一个地址被禁就判不通过。空列表也判不通过。
     *
     * @param addresses 解析出的全部地址
     * @return 全部放行为 true
     */
    fun allAllowed(addresses: List<InetAddress>): Boolean =
        addresses.isNotEmpty() && addresses.none { isBlockedAddress(it) }

    /**
     * 完整校验一个主机：先看名字，再解析，再逐个看地址。
     *
     * @param host 主机（可带 IPv6 方括号）
     * @param resolver DNS 解析器；IP 字面量也会走它（真实实现不会发 DNS 请求）
     * @return 解析出的全部地址，调用方可据此连接
     * @throws TargetDeniedException 名字或任一地址被禁
     * @throws java.net.UnknownHostException 解析失败
     */
    fun check(host: String, resolver: Resolver): List<InetAddress> {
        val h = normalizeHost(host)
        if (isBlockedHostName(h)) throw TargetDeniedException()
        val addresses = resolver.resolve(h)
        if (!allAllowed(addresses)) throw TargetDeniedException()
        return addresses
    }

    /**
     * 判断地址是不是 IPv4。
     *
     * @param address 地址
     * @return IPv4 为 true
     */
    fun isV4(address: InetAddress): Boolean = address is Inet4Address
}

/** 目标被校验拒绝，处理器把它转成 PERMISSION_DENIED */
class TargetDeniedException : Exception(NetTargetPolicy.DENIED_MESSAGE)
