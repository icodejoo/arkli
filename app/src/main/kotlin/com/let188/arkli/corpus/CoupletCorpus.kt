package com.let188.arkli.corpus

import org.json.JSONObject
import java.io.Closeable
import java.io.File
import java.io.RandomAccessFile

/** 语料包里的文本文件名（格式见 docs/design/couplet-corpus.md，打包脚本 scripts/couplet/build_pack.py） */
internal const val FILE_LINES = "lines.txt"

/** 行偏移表文件名 */
internal const val FILE_OFFSETS = "offsets.u32"

/** 分类位图文件名 */
internal const val FILE_FLAGS = "flags.u32"

/** 抽取池序号文件名 */
internal const val FILE_POOLS = "pools.u32"

/** 元数据文件名 */
internal const val FILE_META = "meta.json"

/** 清单里语料包的模型 id */
const val COUPLET_CORPUS_MODEL_ID = "couplet-corpus"

/** 支持的包格式版本 */
private const val PACK_VERSION = 1

/** u32 的字节数 */
private const val U32 = 4

/** flags 里首选分类下标的移位 */
private const val PRIMARY_SHIFT = 16

/** flags 里首选分类下标的掩码 */
private const val PRIMARY_MASK = 0xF

/** 分类位图掩码（低 16 位） */
private const val CAT_MASK = 0xFFFF

/** 单行最大字节数，防止损坏的偏移导致一次读出巨量内存 */
private const val MAX_LINE_BYTES = 64 * 1024

/** 一个字节的掩码 */
private const val BYTE_MASK = 0xFF

/**
 * 一个抽取池。
 *
 * @property name 池名：`全部`（不含挽联）或分类名
 * @property count 池内对联数
 * @property offset 在 pools.u32 里的起点（按 u32 个数计）
 */
data class CorpusPool(val name: String, val count: Int, val offset: Long)

/**
 * 一副对联。
 *
 * @property id 全局序号
 * @property up 上联
 * @property down 下联
 * @property banner 横批（推荐值，不是原联真实横批）
 * @property cats 所属分类名（位图展开）
 * @property primary 首选分类名
 */
data class CoupletRecord(val id: Int, val up: String, val down: String, val banner: String, val cats: List<String>, val primary: String)

/**
 * 对联语料库的随机访问读取器：不把几十 MB 文本读进内存，每次只按偏移读一行。
 * 线程安全（内部串行化读取）。
 *
 * 使用示例：`CoupletCorpus.open(dir).use { it.get(0, 123) }`
 *
 * @param count 总对联数
 * @param cats 分类名（位图顺序）
 * @param pools 全部抽取池
 */
class CoupletCorpus private constructor(
    val count: Int,
    val cats: List<String>,
    val pools: List<CorpusPool>,
    private val lines: RandomAccessFile,
    private val offsets: RandomAccessFile,
    private val flags: RandomAccessFile,
    private val poolIds: RandomAccessFile,
) : Closeable {
    /** 读取缓冲（8 字节够读两个 u32） */
    private val buf = ByteArray(Long.SIZE_BYTES)

    /**
     * 取池里第 [index] 副对联。
     *
     * @param pool 池编号，0 起
     * @param index 池内下标，0 起
     * @return 对联
     * @throws IllegalArgumentException 池或下标越界
     * @throws IllegalStateException 数据文件损坏（偏移越界、行不是三列）
     */
    @Synchronized
    fun get(pool: Int, index: Int): CoupletRecord {
        require(pool in pools.indices) { "池编号越界" }
        val p = pools[pool]
        require(index in 0 until p.count) { "池内下标越界" }
        val id = readU32(poolIds, p.offset + index)
        check(id in 0 until count) { "池里的序号越界" }
        return record(id.toInt())
    }

    /**
     * 按全局序号取一副对联。
     *
     * @param id 0 until [count]
     * @return 对联
     */
    @Synchronized
    fun byId(id: Int): CoupletRecord {
        require(id in 0 until count) { "序号越界" }
        return record(id)
    }

    /** 读一行并拆成三列，再配上位图展开的分类 */
    private fun record(id: Int): CoupletRecord {
        offsets.seek(id.toLong() * U32)
        offsets.readFully(buf, 0, Long.SIZE_BYTES)
        val start = u32(buf, 0)
        val end = u32(buf, U32)
        check(end > start && end - start <= MAX_LINE_BYTES && end <= lines.length()) { "第 $id 行的偏移不合法" }
        val raw = ByteArray((end - start).toInt())
        lines.seek(start)
        lines.readFully(raw)
        val parts = String(raw, Charsets.UTF_8).trimEnd('\n').split('\t')
        check(parts.size == 3) { "第 $id 行不是三列" }
        val f = readU32(flags, id.toLong()).toInt()
        val mask = f and CAT_MASK
        val names = cats.filterIndexed { i, _ -> mask and (1 shl i) != 0 }
        val primary = cats.getOrElse((f ushr PRIMARY_SHIFT) and PRIMARY_MASK) { names.firstOrNull().orEmpty() }
        return CoupletRecord(id, parts[0], parts[1], parts[2], names, primary)
    }

    /** 读 [file] 里第 [index] 个 u32（无符号，用 Long 装） */
    private fun readU32(file: RandomAccessFile, index: Long): Long {
        file.seek(index * U32)
        file.readFully(buf, 0, U32)
        return u32(buf, 0)
    }

    /** 关闭全部文件 */
    @Synchronized
    override fun close() {
        listOf(lines, offsets, flags, poolIds).forEach { runCatching { it.close() } }
    }

    companion object {
        /** 小端 u32 转无符号 Long */
        private fun u32(b: ByteArray, at: Int): Long =
            (b[at].toLong() and BYTE_MASK.toLong()) or
                ((b[at + 1].toLong() and BYTE_MASK.toLong()) shl 8) or
                ((b[at + 2].toLong() and BYTE_MASK.toLong()) shl 16) or
                ((b[at + 3].toLong() and BYTE_MASK.toLong()) shl 24)

        /**
         * 打开语料包目录。会核对 meta 与各文件长度是否自洽，不自洽说明包坏了。
         *
         * @param dir 解压后的目录
         * @return 读取器，用完要 [close]
         * @throws IllegalStateException 文件缺失、版本不支持、长度对不上
         */
        fun open(dir: File): CoupletCorpus {
            val meta = try {
                JSONObject(File(dir, FILE_META).readText(Charsets.UTF_8))
            } catch (e: Exception) {
                throw IllegalStateException("读不到 $FILE_META：${e.message}")
            }
            check(meta.optInt("v") == PACK_VERSION) { "不支持的语料包版本" }
            val count = meta.optInt("count", -1)
            check(count > 0) { "条数不合法" }
            val catArr = meta.optJSONArray("cats") ?: throw IllegalStateException("缺 cats")
            val cats = (0 until catArr.length()).map { catArr.getString(it) }
            val poolArr = meta.optJSONArray("pools") ?: throw IllegalStateException("缺 pools")
            val pools = (0 until poolArr.length()).map {
                val o = poolArr.getJSONObject(it)
                CorpusPool(o.getString("name"), o.getInt("count"), o.getLong("offset"))
            }
            val totalIds = pools.sumOf { it.count.toLong() }
            check(pools.all { it.count >= 0 && it.offset >= 0 && it.offset + it.count <= totalIds }) { "池范围不合法" }
            val files = listOf(FILE_LINES, FILE_OFFSETS, FILE_FLAGS, FILE_POOLS).map { File(dir, it) }
            check(files.all { it.isFile }) { "语料包文件不全" }
            check(files[1].length() == (count + 1L) * U32) { "$FILE_OFFSETS 长度与条数不符" }
            check(files[2].length() == count.toLong() * U32) { "$FILE_FLAGS 长度与条数不符" }
            check(files[3].length() == totalIds * U32) { "$FILE_POOLS 长度与池不符" }
            val opened = mutableListOf<RandomAccessFile>()
            try {
                files.forEach { opened += RandomAccessFile(it, "r") }
                val c = CoupletCorpus(count, cats, pools, opened[0], opened[1], opened[2], opened[3])
                // 最后一个偏移必须正好是文本长度
                c.offsets.seek(count.toLong() * U32)
                c.offsets.readFully(c.buf, 0, U32)
                check(u32(c.buf, 0) == opened[0].length()) { "偏移表末项与 $FILE_LINES 长度不符" }
                return c
            } catch (e: Exception) {
                opened.forEach { runCatching { it.close() } }
                throw e
            }
        }
    }
}
