package com.let188.arkli.model

import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.zip.ZipFile

/** 解压读写缓冲大小 */
private const val UNPACK_BUFFER_BYTES = 64 * 1024

/** 十六进制字符表 */
private const val HEX_CHARS = "0123456789abcdef"

/**
 * 数据包解压：只解清单里列出的文件，其余条目一律拒绝（防路径穿越、防夹带），
 * 每个文件边写边算 sha256，长度或摘要不符就删掉 `.part` 报错，通过才原子改名。
 *
 * 使用示例：`PackExtractor.extract(zip, dir, entry.files)`
 */
internal object PackExtractor {
    /**
     * 解压压缩包。
     *
     * @param zip 压缩包文件（已校验过整体 sha256）
     * @param dir 目标目录
     * @param wanted 要解出的文件（名字、长度、sha256 以清单为准）
     * @param all 清单里的全部解压文件名，压缩包里出现这之外的条目即拒绝
     * @param active 返回 false 时中止并抛 [kotlinx.coroutines.CancellationException]
     * @throws ModelDownloadException UNPACK_FAILED：条目缺失、多余、重复、是目录、声明长度不符或写超；HASH_MISMATCH：解出内容与清单摘要不一致
     */
    fun extract(zip: File, dir: File, wanted: List<ModelFile>, all: Set<String>, active: () -> Boolean = { true }) {
        try {
            ZipFile(zip).use { zf ->
                val seen = HashSet<String>()
                for (e in zf.entries()) {
                    if (e.isDirectory || e.name !in all) throw fail("压缩包里有清单之外的条目：${e.name.take(NAME_PREVIEW)}")
                    if (!seen.add(e.name)) throw fail("压缩包里条目重复：${e.name}")
                }
                for (f in wanted) {
                    val e = zf.getEntry(f.name) ?: throw fail("压缩包缺少 ${f.name}")
                    if (e.size >= 0 && e.size != f.bytes) throw fail("${f.name} 声明长度 ${e.size} 与清单 ${f.bytes} 不符")
                    zf.getInputStream(e).use { input -> writeOne(input, dir, f, active) }
                }
            }
        } catch (e: java.util.zip.ZipException) {
            throw fail("压缩包损坏：${e.message}")
        }
    }

    /** 解出一个文件：写 .part、核对长度与摘要、改名 */
    private fun writeOne(input: java.io.InputStream, dir: File, f: ModelFile, active: () -> Boolean) {
        val part = File(dir, f.name + PART_SUFFIX)
        val target = File(dir, f.name)
        val md = MessageDigest.getInstance("SHA-256")
        var written = 0L
        try {
            FileOutputStream(part).use { out ->
                val buf = ByteArray(UNPACK_BUFFER_BYTES)
                while (true) {
                    if (!active()) throw kotlinx.coroutines.CancellationException("已取消")
                    val n = input.read(buf)
                    if (n < 0) break
                    written += n
                    if (written > f.bytes) throw fail("${f.name} 解出的内容比清单还长")
                    md.update(buf, 0, n)
                    out.write(buf, 0, n)
                }
            }
            if (written != f.bytes) throw fail("${f.name} 解出 $written 字节，清单是 ${f.bytes}")
            if (hex(md.digest()) != f.sha256) throw ModelDownloadException(ModelErrorCode.HASH_MISMATCH, "${f.name} 解压后的 sha256 与清单不一致")
        } catch (e: Throwable) {
            part.delete()
            throw e
        }
        if (target.exists()) target.delete()
        if (!part.renameTo(target)) throw ModelDownloadException(ModelErrorCode.INTERNAL, "无法把 .part 改名为目标文件")
    }

    /** 造解压失败异常（不重试） */
    private fun fail(msg: String) = ModelDownloadException(ModelErrorCode.UNPACK_FAILED, msg)

    /** 字节转小写十六进制 */
    private fun hex(b: ByteArray): String {
        val sb = StringBuilder(b.size * 2)
        b.forEach { sb.append(HEX_CHARS[(it.toInt() shr 4) and 0xF]).append(HEX_CHARS[it.toInt() and 0xF]) }
        return sb.toString()
    }

    /** 错误信息里条目名最多保留的字符数 */
    private const val NAME_PREVIEW = 80
}
