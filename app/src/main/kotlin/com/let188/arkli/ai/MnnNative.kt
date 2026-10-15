package com.let188.arkli.ai

/**
 * MNN 本地文本模型的 JNI 入口，对应 `native/mnn/arkli_mnn_jni.cpp`。
 *
 * 字符串一律以 UTF-8 字节传递，避开 JNI 改良 UTF-8 对 emoji 的拆分，也避开半个汉字导致的崩溃。
 * 业务代码不要直接用它，走 [QwenService]。
 */
internal object MnnNative {
    /** 动态库名（libarkli-mnn.so，依赖同目录的 libMNN.so） */
    private const val LIB_NAME = "arkli-mnn"

    init {
        System.loadLibrary(LIB_NAME)
    }

    /**
     * 创建并加载模型会话。
     *
     * @param configPath 模型目录里 config.json 绝对路径的 UTF-8 字节
     * @return 会话句柄
     * @throws IllegalStateException 配置无法解析或权重不完整
     */
    @JvmStatic
    external fun nativeCreate(configPath: ByteArray): Long

    /**
     * 单轮生成，调用之间互不影响（每次先清历史）。
     *
     * @param handle [nativeCreate] 返回的句柄
     * @param prompt 用户内容的 UTF-8 字节
     * @param maxNewTokens 最多生成的 token 数，小于等于 0 表示用模型缺省
     * @return 生成文本的 UTF-8 字节，末尾可能是被截断的半个字
     * @throws IllegalStateException 句柄无效或推理失败
     */
    @JvmStatic
    external fun nativeGenerate(handle: Long, prompt: ByteArray, maxNewTokens: Int): ByteArray

    /**
     * 释放会话，句柄为 0 时什么也不做。
     *
     * @param handle [nativeCreate] 返回的句柄
     */
    @JvmStatic
    external fun nativeDestroy(handle: Long)
}
