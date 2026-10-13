package com.let188.arkli.image

import java.io.File

/**
 * 解码后的图片，持有的原生资源用 [close] 释放。
 * 抽象出来是为了让 [ImageCompressor] 能在 JVM 单测里注入假实现。
 */
interface CodecImage : AutoCloseable {
    /** 宽（像素，已按 EXIF 摆正） */
    val width: Int

    /** 高（像素，已按 EXIF 摆正） */
    val height: Int

    /**
     * 读出全部像素。
     *
     * @return ARGB（非预乘）数组，长度 = width * height
     */
    fun toArgb(): IntArray

    /** 释放底层资源，可重复调用 */
    override fun close()
}

/** 图片编解码接口：解码、缩放、有损编码、EXIF 复制。PNG 不在这里，走 [PngEncoder] */
interface ImageCodec {
    /**
     * 解码并按 EXIF 摆正。
     *
     * @param file 源文件
     * @param maxEdge 之后要缩到的最长边；用来在解码阶段降采样省内存，可为 null
     * @return 解码结果，尺寸不小于缩放目标（采样只会取 2 的幂）
     * @throws com.let188.arkli.bridge.BridgeException 无法解码（INTERNAL）或像素过多（BAD_PARAMS）
     */
    fun decode(file: File, maxEdge: Int?): CodecImage

    /**
     * 缩放到指定尺寸，不修改也不关闭 [src]。
     *
     * @param src 源图
     * @param width 目标宽
     * @param height 目标高
     * @return 新图，由调用方关闭
     */
    fun scale(src: CodecImage, width: Int, height: Int): CodecImage

    /**
     * 有损编码。
     *
     * @param img 源图
     * @param format [OutFormat.JPEG] 或 [OutFormat.WEBP]
     * @param quality 1..100
     * @return 编码后的字节
     */
    fun encodeLossy(img: CodecImage, format: OutFormat, quality: Int): ByteArray

    /**
     * 把源文件的 EXIF 复制到已写好的 JPEG 上（方向标签重置为正常）。失败时静默忽略。
     *
     * @param src 源文件
     * @param dst 目标 JPEG 文件
     */
    fun copyExif(src: File, dst: File) {}
}
