package com.let188.arkli.ai

import org.json.JSONObject

/**
 * Qwen MNN 运行时配置包装器。
 */
internal object QwenConfigWrapper {
    /** 线程数键名 */
    const val KEY_THREAD_NUM = "thread_num"

    /** 基准目录键名 */
    const val KEY_BASE_DIR = "base_dir"

    /** 路径结尾分隔符 */
    private const val PATH_SEPARATOR = "/"

    /**
     * 包装原始配置，注入线程数与模型基准目录。
     *
     * 返回深拷贝，顶层注入 [KEY_THREAD_NUM] 与保证以 "/" 结尾的 [KEY_BASE_DIR]，不动内嵌结构，不修改入参。
     *
     * @param original 原始配置 JSON 对象（纯读，不修改）
     * @param modelDir 模型所在目录路径
     * @param threads 推理线程数
     * @return 注入后的新 JSON 对象
     * @example `val config = QwenConfigWrapper.wrap(original, "/path/to/model", 4)`
     */
    fun wrap(original: JSONObject, modelDir: String, threads: Int): JSONObject {
        val copy = JSONObject(original.toString())
        copy.put(KEY_THREAD_NUM, threads)
        val baseDir = if (modelDir.endsWith(PATH_SEPARATOR)) modelDir else "$modelDir$PATH_SEPARATOR"
        copy.put(KEY_BASE_DIR, baseDir)
        return copy
    }
}
