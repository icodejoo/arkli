package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * MNN 共享参数、配置包装与服务重载单测。
 */
class AiMnnParamsTest {
    /** 临时目录 */
    @get:Rule
    val tmp = TemporaryFolder()

    /** 内存参数存储 */
    private val store = InMemoryAiParamStore()

    /** 空提供者列表 */
    private val emptyProviders = emptyList<AiProvider>()

    /**
     * 辅助构造 set 请求。
     *
     * @param kv 键值对
     * @return 请求 JSON
     */
    private fun makeSet(vararg kv: Pair<String, Any>): JSONObject =
        JSONObject().put(KEY_PROVIDER, AiMnnParams.PROVIDER_ID).put(
            KEY_VALUES,
            JSONObject().also { o -> kv.forEach { o.put(it.first, it.second) } },
        )

    /**
     * 断言代码块抛出 BAD_PARAMS 桥异常。
     *
     * @param block 待执行代码块
     */
    private fun assertBad(block: () -> Unit) {
        val e = runCatching(block).exceptionOrNull()
        assertTrue("应抛出 BAD_PARAMS，实际为 $e", e is BridgeException && e.code == BridgeErrors.BAD_PARAMS)
    }

    /** 记录调用的对联引擎替身 */
    private class FakeCoupletBackend : CoupletBackend {
        /** 调用记录列表 */
        val calls = mutableListOf<String>()

        override fun load(modelDir: String) { calls += CALL_LOAD }
        override fun unload() { calls += CALL_UNLOAD }
        override fun generate(req: AiCoupletRequest): CoupletOutcome {
            calls += CALL_GENERATE
            return CoupletOutcome(RESULT_COUPLET_TEXT, 10L)
        }
        override fun cancel() {}
    }

    @Test
    fun mnn_get_returnsDefaultsAndSpecs() {
        val params = JSONObject().put(KEY_PROVIDER, AiMnnParams.PROVIDER_ID)
        val res = AiParams.handleGet(params, emptyProviders, store)
        val specs = res.getJSONArray(KEY_SPECS)
        assertEquals(2, specs.length())
        val spec = specs.getJSONObject(0)
        assertEquals(AiMnnParams.KEY_NUM_THREAD, spec.getString(AiParamSpec.KEY_KEY))
        assertEquals(AiParamKind.STEPPER.wire, spec.getString(AiParamSpec.KEY_KIND))
        assertEquals(AiParamScope.SESSION.wire, spec.getString(AiParamSpec.KEY_SCOPE))
        assertEquals(AiMnnParams.DEFAULT_THREADS.toDouble(), spec.getDouble(AiParamSpec.KEY_DEFAULT), EPSILON)
        assertEquals(AiMnnParams.MIN.toDouble(), spec.getDouble(AiParamSpec.KEY_MIN), EPSILON)
        assertEquals(AiMnnParams.MAX.toDouble(), spec.getDouble(AiParamSpec.KEY_MAX), EPSILON)
        val values = res.getJSONObject(KEY_VALUES)
        assertEquals(AiMnnParams.DEFAULT_THREADS.toDouble(), values.getDouble(AiMnnParams.KEY_NUM_THREAD), EPSILON)
        assertEquals(AiMnnParams.DEFAULT_THREADS.toUInt(), AiMnnParams.threads(store))
    }

    @Test
    fun mnn_set_and_reset_roundTrips() {
        // 设置为 2
        val setRes = AiParams.handleSet(makeSet(AiMnnParams.KEY_NUM_THREAD to 2), emptyProviders, store)
        assertEquals(2.0, setRes.getJSONObject(KEY_VALUES).getDouble(AiMnnParams.KEY_NUM_THREAD), EPSILON)
        assertEquals(2u, AiMnnParams.threads(store))
        assertEquals(2.0, store.get(AiMnnParams.PROVIDER_ID, AiMnnParams.KEY_NUM_THREAD)!!, EPSILON)

        // 设回默认 4：自动删键
        val backRes = AiParams.handleSet(makeSet(AiMnnParams.KEY_NUM_THREAD to 4), emptyProviders, store)
        assertEquals(4.0, backRes.getJSONObject(KEY_VALUES).getDouble(AiMnnParams.KEY_NUM_THREAD), EPSILON)
        assertEquals(4u, AiMnnParams.threads(store))
        assertNull(store.get(AiMnnParams.PROVIDER_ID, AiMnnParams.KEY_NUM_THREAD))

        // 重置单个 key
        AiParams.handleSet(makeSet(AiMnnParams.KEY_NUM_THREAD to 5), emptyProviders, store)
        val resetKeyRes = AiParams.handleReset(
            JSONObject().put(KEY_PROVIDER, AiMnnParams.PROVIDER_ID)
                .put(KEY_KEYS, JSONArray().put(AiMnnParams.KEY_NUM_THREAD)),
            emptyProviders,
            store,
        )
        assertEquals(4.0, resetKeyRes.getJSONObject(KEY_VALUES).getDouble(AiMnnParams.KEY_NUM_THREAD), EPSILON)
        assertNull(store.get(AiMnnParams.PROVIDER_ID, AiMnnParams.KEY_NUM_THREAD))

        // 重置全部 keys
        AiParams.handleSet(makeSet(AiMnnParams.KEY_NUM_THREAD to 6), emptyProviders, store)
        val resetAllRes = AiParams.handleReset(
            JSONObject().put(KEY_PROVIDER, AiMnnParams.PROVIDER_ID),
            emptyProviders,
            store,
        )
        assertEquals(4.0, resetAllRes.getJSONObject(KEY_VALUES).getDouble(AiMnnParams.KEY_NUM_THREAD), EPSILON)
        assertNull(store.get(AiMnnParams.PROVIDER_ID, AiMnnParams.KEY_NUM_THREAD))
    }

    @Test
    fun mnn_set_rejectsOutOfRangeAndNonIntegers() {
        // 越界：0
        assertBad { AiParams.handleSet(makeSet(AiMnnParams.KEY_NUM_THREAD to 0), emptyProviders, store) }
        // 越界：7
        assertBad { AiParams.handleSet(makeSet(AiMnnParams.KEY_NUM_THREAD to 7), emptyProviders, store) }
        // 非整数：2.5
        assertBad { AiParams.handleSet(makeSet(AiMnnParams.KEY_NUM_THREAD to 2.5), emptyProviders, store) }
        // 非数字："four"
        assertBad { AiParams.handleSet(makeSet(AiMnnParams.KEY_NUM_THREAD to "four"), emptyProviders, store) }
        // 未知 key
        assertBad { AiParams.handleSet(makeSet(KEY_UNKNOWN to 4), emptyProviders, store) }
    }

    @Test
    fun providers_doesNotContainMnn() {
        val providers = AiFixtures.registered(tmp)
        assertTrue(
            "providers 列表中不得包含 mnn 提供者",
            providers.none { it.id == AiMnnParams.PROVIDER_ID },
        )
    }

    @Test
    fun mnn_fingerprint_changesWithNumThread() {
        val before = AiMnnParams.fingerprint(LocalClipProvider.ID, AiClassifyPolicy.PARAM_SPECS, store)
        assertTrue(before.contains("${AiMnnParams.PROVIDER_ID}.${AiMnnParams.KEY_NUM_THREAD}=4.0"))

        store.set(AiMnnParams.PROVIDER_ID, AiMnnParams.KEY_NUM_THREAD, 5.0)
        val after = AiMnnParams.fingerprint(LocalClipProvider.ID, AiClassifyPolicy.PARAM_SPECS, store)
        assertNotEquals(before, after)
        assertTrue(after.contains("${AiMnnParams.PROVIDER_ID}.${AiMnnParams.KEY_NUM_THREAD}=5.0"))

        // 无自身参数的提供者（如 OCR）
        val ocrBefore = AiMnnParams.fingerprint(LocalOcrProvider.ID, emptyList(), store)
        assertTrue(ocrBefore.contains("${AiMnnParams.PROVIDER_ID}.${AiMnnParams.KEY_NUM_THREAD}=5.0"))
        store.set(AiMnnParams.PROVIDER_ID, AiMnnParams.KEY_NUM_THREAD, 2.0)
        val ocrAfter = AiMnnParams.fingerprint(LocalOcrProvider.ID, emptyList(), store)
        assertNotEquals(ocrBefore, ocrAfter)
        assertTrue(ocrAfter.contains("${AiMnnParams.PROVIDER_ID}.${AiMnnParams.KEY_NUM_THREAD}=2.0"))
    }

    @Test
    fun service_reloadsOnNumThreadChange() {
        val dir = tmp.newFolder().also { d ->
            CoupletService.REQUIRED_FILES.forEach { File(d, it).writeText("x") }
        }
        val backend = FakeCoupletBackend()
        val env = object : CoupletEnv { override fun modelDir() = dir }
        val svc = CoupletService(
            env,
            backend,
            settingsKey = { AiMnnParams.fingerprint(LocalCoupletProvider.ID, AiCoupletPolicy.PARAM_SPECS, store) },
        )
        val req = AiCoupletRequest(null, "春风送暖")

        runBlocking {
            // 首次调用：load + generate
            svc.generate(req)
            assertEquals(listOf(CALL_LOAD, CALL_GENERATE), backend.calls)

            // 第二次调用（未改参数）：仅 generate，不重载
            svc.generate(req)
            assertEquals(listOf(CALL_LOAD, CALL_GENERATE, CALL_GENERATE), backend.calls)

            // 修改线程数
            store.set(AiMnnParams.PROVIDER_ID, AiMnnParams.KEY_NUM_THREAD, 2.0)

            // 第三次调用：触发 unload + load + generate
            svc.generate(req)
            assertEquals(
                listOf(CALL_LOAD, CALL_GENERATE, CALL_GENERATE, CALL_UNLOAD, CALL_LOAD, CALL_GENERATE),
                backend.calls,
            )
        }
    }

    @Test
    fun mnn_power_defaultsAndRoundTrip() {
        assertEquals(AiMnnParams.POWER_NORMAL, AiMnnParams.power(store))
        AiParams.handleSet(makeSet(AiMnnParams.KEY_POWER to 1), emptyProviders, store)
        assertEquals(AiMnnParams.POWER_HIGH, AiMnnParams.power(store))
        // 不在选项里的值被拒（省电档 2 已下线）
        assertBad { AiParams.handleSet(makeSet(AiMnnParams.KEY_POWER to 2), emptyProviders, store) }
        assertBad { AiParams.handleSet(makeSet(AiMnnParams.KEY_POWER to 3), emptyProviders, store) }
        // 精度整项不开放
        assertTrue(AiMnnParams.SPECS.none { it.key == "precision" })
    }

    @Test
    fun mnn_fingerprint_changesWithPower() {
        val base = AiMnnParams.fingerprint(LocalOcrProvider.ID, emptyList(), store)
        store.set(AiMnnParams.PROVIDER_ID, AiMnnParams.KEY_POWER, 1.0)
        val afterPower = AiMnnParams.fingerprint(LocalOcrProvider.ID, emptyList(), store)
        assertNotEquals(base, afterPower)
    }

    @Test
    fun qwen_topPAndPenalty_defaultsAndFingerprint() {
        assertEquals(0.95, AiQwenPolicy.topP(store), EPSILON)
        assertEquals(1.1, AiQwenPolicy.repetitionPenalty(store), EPSILON)
        val before = AiMnnParams.fingerprint(LocalQwenProvider.ID, AiQwenPolicy.PARAM_SPECS, store)
        store.set(LocalQwenProvider.ID, AiQwenPolicy.KEY_TOP_P, 0.8)
        val mid = AiMnnParams.fingerprint(LocalQwenProvider.ID, AiQwenPolicy.PARAM_SPECS, store)
        assertNotEquals(before, mid)
        store.set(LocalQwenProvider.ID, AiQwenPolicy.KEY_REPETITION_PENALTY, 1.2)
        assertNotEquals(mid, AiMnnParams.fingerprint(LocalQwenProvider.ID, AiQwenPolicy.PARAM_SPECS, store))
        assertEquals(0.8, AiQwenPolicy.topP(store), EPSILON)
        assertEquals(1.2, AiQwenPolicy.repetitionPenalty(store), EPSILON)
    }

    @Test
    fun qwenConfigWrapper_powerSampling() {
        val original = JSONObject().put("precision", "low").put("topP", 0.95).put("penalty", 1.1)
        // 默认：不动 power，也不动采样
        val d = QwenConfigWrapper.wrap(original, "/m", 4)
        assertTrue(!d.has(QwenConfigWrapper.KEY_POWER))
        // 模型自带的 precision 原样保留
        assertEquals("low", d.getString("precision"))
        assertEquals(0.95, d.getDouble(QwenConfigWrapper.KEY_TOP_P), EPSILON)
        // 性能 + 采样覆盖
        val h = QwenConfigWrapper.wrap(original, "/m", 4, power = 1, topP = 0.8, penalty = 1.2)
        assertEquals("high", h.getString(QwenConfigWrapper.KEY_POWER))
        assertEquals(0.8, h.getDouble(QwenConfigWrapper.KEY_TOP_P), EPSILON)
        assertEquals(1.2, h.getDouble(QwenConfigWrapper.KEY_PENALTY), EPSILON)
        // 省电档已下线：2 不写键
        assertTrue(!QwenConfigWrapper.wrap(original, "/m", 4, power = 2).has(QwenConfigWrapper.KEY_POWER))
        // 不改入参
        assertEquals("low", original.getString("precision"))
        assertTrue(!original.has(QwenConfigWrapper.KEY_POWER))
    }

    @Test
    fun qwenConfigWrapper_pureFunctionTest() {
        val original = JSONObject().apply {
            put(QwenConfigWrapper.KEY_THREAD_NUM, 2)
            put(KEY_MLLM, JSONObject().put(QwenConfigWrapper.KEY_THREAD_NUM, 1).put(KEY_BACKEND, "cpu"))
            put(KEY_MODEL_TYPE, "qwen")
        }
        val originalSnapshot = original.toString()
        val modelDirWithoutSlash = "/data/user/0/com.let188.arkli/files/models/qwen"

        // 测试覆盖 thread_num、加 base_dir 斜杠、不动 mllm、不改入参
        val wrapped1 = QwenConfigWrapper.wrap(original, modelDirWithoutSlash, 6)
        assertEquals(6, wrapped1.getInt(QwenConfigWrapper.KEY_THREAD_NUM))
        assertEquals("$modelDirWithoutSlash/", wrapped1.getString(QwenConfigWrapper.KEY_BASE_DIR))
        assertEquals(1, wrapped1.getJSONObject(KEY_MLLM).getInt(QwenConfigWrapper.KEY_THREAD_NUM))
        assertEquals("cpu", wrapped1.getJSONObject(KEY_MLLM).getString(KEY_BACKEND))
        assertEquals("qwen", wrapped1.getString(KEY_MODEL_TYPE))
        assertEquals("不改入参", originalSnapshot, original.toString())

        // 测试已有斜杠不重复加
        val modelDirWithSlash = "/data/user/0/com.let188.arkli/files/models/qwen/"
        val wrapped2 = QwenConfigWrapper.wrap(original, modelDirWithSlash, 3)
        assertEquals(3, wrapped2.getInt(QwenConfigWrapper.KEY_THREAD_NUM))
        assertEquals(modelDirWithSlash, wrapped2.getString(QwenConfigWrapper.KEY_BASE_DIR))
    }

    private companion object {
        /** 浮点容差 */
        const val EPSILON = 1e-9

        /** 参数键：提供者 */
        const val KEY_PROVIDER = "provider"

        /** 参数键：规格列表 */
        const val KEY_SPECS = "specs"

        /** 参数键：生效值映射 */
        const val KEY_VALUES = "values"

        /** 参数键：重置键列表 */
        const val KEY_KEYS = "keys"

        /** 未知测试键 */
        const val KEY_UNKNOWN = "unknown_key"

        /** 后端调用：加载 */
        const val CALL_LOAD = "load"

        /** 后端调用：卸载 */
        const val CALL_UNLOAD = "unload"

        /** 后端调用：生成 */
        const val CALL_GENERATE = "generate"

        /** 替身对联文本 */
        const val RESULT_COUPLET_TEXT = "万象更新"

        /** mllm 配置键 */
        const val KEY_MLLM = "mllm"

        /** 后端类型键 */
        const val KEY_BACKEND = "backend"

        /** 模型类型键 */
        const val KEY_MODEL_TYPE = "model_type"
    }
}
