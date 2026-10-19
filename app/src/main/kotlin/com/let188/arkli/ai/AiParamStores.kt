package com.let188.arkli.ai

import android.content.Context

/**
 * AI 参数存储单例管理器。
 */
internal object AiParamStores {
    /** 进程内唯一的参数存储实例 */
    @Volatile
    private var instance: AiParamStore? = null

    /**
     * 获取参数持久化存储单例。
     *
     * @param context 安卓应用上下文
     * @return 进程内唯一的 [AiParamStore] 实例
     * @example `val store = AiParamStores.get(context)`
     */
    fun get(context: Context): AiParamStore =
        instance ?: synchronized(this) {
            instance ?: SharedPrefsAiParamStore(context.applicationContext).also { instance = it }
        }
}
