package com.let188.arkli.corpus

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** 语料读取器：按语料包格式手写一个小包，核对随机访问、分类展开与损坏检测 */
class CoupletCorpusTest {
    /** 临时目录 */
    @get:Rule
    val tmp = TemporaryFolder()

    /** 分类名（只用四个，位图顺序同） */
    private val cats = listOf("春节", "山水", "挽联", "通用")

    /** 样例：（行文本，位图，首选下标） */
    private val rows = listOf(
        Triple("春风送暖\t瑞雪兆丰\t万象更新", 0b0001, 0),
        Triple("山高水长\t云淡风轻\t山河入画", 0b0010, 1),
        Triple("音容宛在\t哀思长存\t音容永存", 0b0100, 2),
        Triple("志在千里\t心系万家\t鹏程万里", 0b1010, 1),
    )

    /** 池：0=全部（不含挽联）：[0,1,3]；1=春节：[0]；2=山水：[1,3]；3=挽联：[2] */
    private val pools = listOf("全部" to listOf(0, 1, 3), "春节" to listOf(0), "山水" to listOf(1, 3), "挽联" to listOf(2))

    /** 写一个 u32 小端文件 */
    private fun u32File(name: String, values: List<Long>) {
        val bb = ByteBuffer.allocate(values.size * 4).order(ByteOrder.LITTLE_ENDIAN)
        values.forEach { bb.putInt(it.toInt()) }
        File(tmp.root, name).writeBytes(bb.array())
    }

    /** 写全套文件；[mutate] 可在写完后动手脚造损坏 */
    private fun writePack(mutate: () -> Unit = {}): File {
        val text = ByteArrayOutputStream()
        val offs = mutableListOf<Long>()
        rows.forEach {
            offs += text.size().toLong()
            text.write((it.first + "\n").toByteArray())
        }
        offs += text.size().toLong()
        File(tmp.root, FILE_LINES).writeBytes(text.toByteArray())
        u32File(FILE_OFFSETS, offs)
        u32File(FILE_FLAGS, rows.map { (it.second or (it.third shl 16)).toLong() })
        val flat = pools.flatMap { it.second }.map { it.toLong() }
        u32File(FILE_POOLS, flat)
        var at = 0
        val metaPools = JSONArray()
        pools.forEach { (n, ids) ->
            metaPools.put(JSONObject().put("name", n).put("count", ids.size).put("offset", at))
            at += ids.size
        }
        File(tmp.root, FILE_META).writeText(JSONObject().put("v", 1).put("count", rows.size).put("cats", JSONArray(cats)).put("pools", metaPools).toString())
        mutate()
        return tmp.root
    }

    @Test
    fun get_readsRandomAccessAndExpandsCategories() {
        CoupletCorpus.open(writePack()).use { c ->
            assertEquals(4, c.count)
            assertEquals(listOf(3, 1, 2, 1), c.pools.map { it.count })
            val r = c.get(0, 2)
            assertEquals(3, r.id)
            assertEquals("志在千里", r.up)
            assertEquals("心系万家", r.down)
            assertEquals("鹏程万里", r.banner)
            assertEquals(listOf("山水", "通用"), r.cats)
            assertEquals("山水", r.primary)
            assertEquals("春风送暖", c.get(1, 0).up)
            assertEquals("挽联", c.get(3, 0).primary)
        }
    }

    @Test
    fun get_allPoolMembersExcludeMourning() {
        CoupletCorpus.open(writePack()).use { c ->
            val seen = (0 until c.pools[0].count).map { c.get(0, it) }
            assertTrue(seen.none { "挽联" in it.cats })
            assertEquals(listOf(0, 1, 3), seen.map { it.id })
        }
    }

    @Test
    fun get_outOfRangeIsRejected() {
        CoupletCorpus.open(writePack()).use { c ->
            assertThrows(IllegalArgumentException::class.java) { c.get(9, 0) }
            assertThrows(IllegalArgumentException::class.java) { c.get(0, 3) }
            assertThrows(IllegalArgumentException::class.java) { c.get(0, -1) }
            assertThrows(IllegalArgumentException::class.java) { c.byId(4) }
        }
    }

    @Test
    fun open_detectsTruncatedFiles() {
        val dir = writePack { File(tmp.root, FILE_OFFSETS).writeBytes(ByteArray(8)) }
        assertThrows(IllegalStateException::class.java) { CoupletCorpus.open(dir) }
    }

    @Test
    fun open_detectsTextLengthMismatch() {
        val dir = writePack { File(tmp.root, FILE_LINES).appendText("多出来的\n") }
        assertThrows(IllegalStateException::class.java) { CoupletCorpus.open(dir) }
    }

    @Test
    fun open_detectsMissingFileAndBadVersion() {
        val dir = writePack { File(tmp.root, FILE_FLAGS).delete() }
        assertThrows(IllegalStateException::class.java) { CoupletCorpus.open(dir) }
        val dir2 = writePack { File(tmp.root, FILE_META).writeText("""{"v":2,"count":4,"cats":[],"pools":[]}""") }
        assertThrows(IllegalStateException::class.java) { CoupletCorpus.open(dir2) }
    }

    @Test
    fun get_badLineShapeIsReportedNotCrashing() {
        // 把第一行的制表符换成空格：列数不对
        val dir = writePack { File(tmp.root, FILE_LINES).let { f -> f.writeBytes(f.readBytes().also { b -> b[b.indexOf('\t'.code.toByte())] = ' '.code.toByte() }) } }
        CoupletCorpus.open(dir).use { c -> assertThrows(IllegalStateException::class.java) { c.byId(0) } }
    }

    @Test
    fun get_handlesOffsetsAbove2GiBAsUnsigned() {
        // 仅验证无符号解读：把偏移表第 2 项改成 0xFFFFFFFF，应报偏移不合法而不是负数崩溃
        val dir = writePack {
            val f = File(tmp.root, FILE_OFFSETS)
            val b = f.readBytes()
            for (i in 4..7) b[i] = 0xFF.toByte()
            f.writeBytes(b)
        }
        // 末项仍对得上文本长度，所以能打开；读到第 0 行时 end 超出文本长度
        CoupletCorpus.open(dir).use { c -> assertThrows(IllegalStateException::class.java) { c.byId(0) } }
    }
}
