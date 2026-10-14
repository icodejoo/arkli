package com.let188.arkli.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.InetAddress

/** SSRF 目标校验的纯函数测试 */
class NetTargetPolicyTest {
    /** 按字面量构造地址（不会触发 DNS） */
    private fun ip(s: String): InetAddress = InetAddress.getByName(s)

    /** 一批地址都应被禁 */
    private fun blocked(vararg s: String) = s.forEach { assertTrue("$it 应被拒", NetTargetPolicy.isBlockedAddress(ip(it))) }

    /** 一批地址都应放行 */
    private fun allowed(vararg s: String) = s.forEach { assertFalse("$it 应放行", NetTargetPolicy.isBlockedAddress(ip(it))) }

    @Test
    fun ipv4_blocked_ranges() {
        blocked(
            "127.0.0.1", "127.255.255.255", "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255",
            "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "100.127.255.255",
            "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
        )
    }

    @Test
    fun ipv4_range_edges_allowed() {
        allowed("8.8.8.8", "1.1.1.1", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "169.253.1.1", "192.167.1.1", "223.255.255.255", "11.0.0.1")
    }

    @Test
    fun ipv6_blocked_ranges() {
        blocked("::1", "::", "fc00::1", "fdff::1", "fe80::1", "febf::1", "ff02::1", "ff00::")
    }

    @Test
    fun ipv6_mapped_and_nat64_use_embedded_v4() {
        blocked("::ffff:127.0.0.1", "::ffff:10.1.2.3", "::ffff:169.254.169.254", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe")
        allowed("2606:4700:4700::1111", "2001:4860:4860::8888", "64:ff9b::808:808")
    }

    @Test
    fun hostnames_blocked() {
        listOf("localhost", "LOCALHOST", "a.localhost", "printer.local", "db.internal", "nas.lan", "router.home.arpa", "intranet", "localhost.").forEach {
            assertTrue("$it 应被拒", NetTargetPolicy.isBlockedHostName(it))
        }
        listOf("example.com", "a.b.example.org", "8.8.8.8", "[::1]").forEach {
            assertFalse("$it 名字本身不拒", NetTargetPolicy.isBlockedHostName(it))
        }
    }

    @Test
    fun valid_host_format() {
        listOf("example.com", "a-b.c_d.org", "8.8.8.8", "2001:db8::1", "[2001:db8::1]", "xn--fiq228c.com").forEach { assertTrue(it, NetTargetPolicy.isValidHost(it)) }
        listOf("", "a b.com", "-a.com", "a..com", "exa/mple.com", "中文.com", "a".repeat(64) + ".com", "x".repeat(254)).forEach { assertFalse(it, NetTargetPolicy.isValidHost(it)) }
    }

    @Test
    fun check_denies_when_any_address_blocked() {
        val resolver = Resolver { listOf(ip("8.8.8.8"), ip("10.0.0.1")) }
        assertThrows(TargetDeniedException::class.java) { NetTargetPolicy.check("mixed.example.com", resolver) }
    }

    @Test
    fun check_allows_public_and_returns_addresses() {
        val resolver = Resolver { listOf(ip("93.184.216.34")) }
        assertEquals(1, NetTargetPolicy.check("example.com", resolver).size)
    }

    @Test
    fun check_denies_blocked_name_without_resolving() {
        var called = false
        val resolver = Resolver {
            called = true
            listOf(ip("8.8.8.8"))
        }
        assertThrows(TargetDeniedException::class.java) { NetTargetPolicy.check("localhost", resolver) }
        assertFalse(called)
    }

    @Test
    fun check_denies_ip_literal_and_empty_result() {
        val real = Resolver { listOf(ip(it)) }
        assertThrows(TargetDeniedException::class.java) { NetTargetPolicy.check("[::1]", real) }
        assertThrows(TargetDeniedException::class.java) { NetTargetPolicy.check("169.254.169.254", real) }
        assertThrows(TargetDeniedException::class.java) { NetTargetPolicy.check("a.example.com", Resolver { emptyList() }) }
    }
}
