package com.let188.arkli.files

import java.io.InputStream
import java.io.OutputStream

/** 拷贝量超过上限 */
class SizeLimitException(message: String) : Exception(message)

/** 带上限与取消检查点的流拷贝，不依赖 android */
object StreamCopy {
    /**
     * 分块拷贝，每块之前调一次 [checkpoint]（挂起函数里可传 ensureActive），累计超过上限即中止。
     *
     * @param input 源流，不负责关闭
     * @param out 目标流，不负责关闭
     * @param maxBytes 允许拷贝的最大字节数
     * @param checkpoint 每块前的检查点，可抛异常中止拷贝
     * @return 实际拷贝字节数
     * @throws SizeLimitException 超过 [maxBytes]
     */
    inline fun copy(input: InputStream, out: OutputStream, maxBytes: Long, checkpoint: () -> Unit = {}): Long {
        val buf = ByteArray(FileConst.COPY_BUF_BYTES)
        var total = 0L
        while (true) {
            checkpoint()
            val n = input.read(buf)
            if (n < 0) break
            total += n
            if (total > maxBytes) throw SizeLimitException("超过 $maxBytes 字节")
            out.write(buf, 0, n)
        }
        return total
    }
}
