package com.let188.arkli.ai

import android.content.Context
import android.content.SharedPreferences

/**
 * AI 参数持久化存储接口。
 */
interface AiParamStore {
    /**
     * 读取指定提供者的参数值。
     *
     * @param provider 提供者 id
     * @param key 参数键
     * @return 存储的数值；未存储时返回 null
     * @example `store.get("local-qwen", "temperature")`
     */
    fun get(provider: String, key: String): Double?

    /**
     * 写入参数值。
     *
     * @param provider 提供者 id
     * @param key 参数键
     * @param value 数值
     * @example `store.set("local-qwen", "temperature", 0.8)`
     */
    fun set(provider: String, key: String, value: Double)

    /**
     * 删除指定参数的存储值。
     *
     * @param provider 提供者 id
     * @param key 参数键
     * @example `store.remove("local-qwen", "temperature")`
     */
    fun remove(provider: String, key: String)

    /**
     * 清空指定提供者的全部已存参数。
     *
     * @param provider 提供者 id
     * @example `store.clearProvider("local-qwen")`
     */
    fun clearProvider(provider: String)
}

/**
 * 读取参数的生效值：若已存储且在当前 spec 范围内则返回存储值；若未存储返回 spec.default；若存储值不在合法范围内则回落默认并删键。
 *
 * @param provider 提供者 id
 * @param spec 参数规格
 * @return 生效数值
 * @example `store.effectiveValue("local-qwen", spec)`
 */
fun AiParamStore.effectiveValue(provider: String, spec: AiParamSpec): Double = userValue(provider, spec) ?: spec.default

/**
 * 读取用户显式设置过的值：已存储且在当前 spec 范围内返回它；未存储返回 null；存了但已越界则删键并返回 null。
 *
 * @param provider 提供者 id
 * @param spec 参数规格
 * @return 用户设置值；没有则 null
 * @example `store.userValue("local-qwen", spec)`
 */
fun AiParamStore.userValue(provider: String, spec: AiParamSpec): Double? {
    val stored = get(provider, spec.key) ?: return null
    if (spec.isValidValue(stored)) return stored
    remove(provider, spec.key)
    return null
}

/** 存储键前缀分隔符：键形如 `provider.key` */
private const val KEY_SEPARATOR = "."

/**
 * 拼出存储键。
 *
 * @param provider 提供者 id
 * @param key 参数键
 * @return `provider.key`
 */
private fun storageKey(provider: String, key: String): String = "$provider$KEY_SEPARATOR$key"

/**
 * 某提供者全部存储键的前缀。
 *
 * @param provider 提供者 id
 * @return `provider.`
 */
private fun storagePrefix(provider: String): String = "$provider$KEY_SEPARATOR"

/**
 * 内存实现的 [AiParamStore]，用于单测与无 Context 场景。
 */
class InMemoryAiParamStore : AiParamStore {
    private val data = mutableMapOf<String, Double>()

    override fun get(provider: String, key: String): Double? = data[storageKey(provider, key)]

    override fun set(provider: String, key: String, value: Double) {
        data[storageKey(provider, key)] = value
    }

    override fun remove(provider: String, key: String) {
        data.remove(storageKey(provider, key))
    }

    override fun clearProvider(provider: String) {
        val prefix = storagePrefix(provider)
        data.keys.filter { it.startsWith(prefix) }.toList().forEach { data.remove(it) }
    }
}

/**
 * 基于 Android SharedPreferences 的 AI 参数持久化存储。
 *
 * @param context 安卓应用上下文
 */
class SharedPrefsAiParamStore(context: Context) : AiParamStore {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    override fun get(provider: String, key: String): Double? =
        prefs.getString(storageKey(provider, key), null)?.toDoubleOrNull()

    override fun set(provider: String, key: String, value: Double) {
        // SharedPreferences 没有 Double 类型，所以存成字符串
        prefs.edit().putString(storageKey(provider, key), value.toString()).apply()
    }

    override fun remove(provider: String, key: String) {
        prefs.edit().remove(storageKey(provider, key)).apply()
    }

    override fun clearProvider(provider: String) {
        val prefix = storagePrefix(provider)
        val editor = prefs.edit()
        prefs.all.keys.filter { it.startsWith(prefix) }.forEach { editor.remove(it) }
        editor.apply()
    }

    companion object {
        /** SharedPreferences 文件名 */
        const val PREFS_NAME = "ai_params"
    }
}
