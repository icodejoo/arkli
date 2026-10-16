package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

/** 翻译纯逻辑：参数校验、结果序列化（选提供者见 AiRouterTest） */
class AiTranslatePolicyTest {
    /** 断言抛指定错误码 */
    private fun assertCode(code: String, block: () -> Unit) {
        val e = assertThrows(BridgeException::class.java) { block() }
        assertEquals(code, e.code)
    }

    /** 解析一段 JSON 参数 */
    private fun parse(json: String) = AiTranslatePolicy.parse(JSONObject(json))

    @Test
    fun parse_minimal_defaultsBeamsToNull() {
        val r = parse("""{"text":"你好","src":"zh-CN","tgt":"en"}""")
        assertEquals(AiTranslateRequest("你好", "zh-CN", "en", null), r)
    }

    @Test
    fun parse_full_andNullBeams() {
        assertEquals(4, parse("""{"text":"a","src":"en","tgt":"fr","numBeams":4}""").numBeams)
        assertEquals(1, parse("""{"text":"a","src":"en","tgt":"fr","numBeams":1}""").numBeams)
        assertNull(parse("""{"text":"a","src":"en","tgt":"fr","numBeams":null}""").numBeams)
    }

    @Test
    fun parse_acceptsAllSixLanguages() {
        AiTranslatePolicy.LANGS.forEach { l ->
            val other = AiTranslatePolicy.LANGS.first { it != l }
            checkAll("""{"text":"x","src":"$l","tgt":"$other"}""")
        }
        assertEquals(listOf("zh-CN", "en", "fr", "es", "ru", "ar"), AiTranslatePolicy.LANGS)
    }

    @Test
    fun parse_rejectsBadText() {
        assertCode(BridgeErrors.BAD_PARAMS) { parse("""{"src":"en","tgt":"fr"}""") }
        assertCode(BridgeErrors.BAD_PARAMS) { parse("""{"text":5,"src":"en","tgt":"fr"}""") }
        assertCode(BridgeErrors.BAD_PARAMS) { parse("""{"text":"","src":"en","tgt":"fr"}""") }
        assertCode(BridgeErrors.BAD_PARAMS) { parse("""{"text":"  \n\t ","src":"en","tgt":"fr"}""") }
    }

    @Test
    fun parse_textLengthBoundary() {
        val ok = "a".repeat(AiTranslatePolicy.MAX_TEXT)
        assertEquals(ok, parse("""{"text":"$ok","src":"en","tgt":"fr"}""").text)
        val tooLong = "a".repeat(AiTranslatePolicy.MAX_TEXT + 1)
        assertCode(BridgeErrors.BAD_PARAMS) { parse("""{"text":"$tooLong","src":"en","tgt":"fr"}""") }
    }

    /** 按全量语言清单（NLLB/Qwen 的报价）校验一段请求的语言 */
    private fun checkAll(json: String) = AiTranslatePolicy.checkLanguages(parse(json), AiTranslatePolicy.LANGS, sourceAuto = true)

    @Test
    fun parse_rejectsMalformedLanguages() {
        assertCode(BridgeErrors.BAD_PARAMS) { parse("""{"text":"a","tgt":"fr"}""") }
        assertCode(BridgeErrors.BAD_PARAMS) { parse("""{"text":"a","src":"en"}""") }
        assertCode(BridgeErrors.BAD_PARAMS) { parse("""{"text":"a","src":7,"tgt":"en"}""") }
        assertCode(BridgeErrors.BAD_PARAMS) { parse("""{"text":"a","src":"","tgt":"en"}""") }
    }

    @Test
    fun checkLanguages_rejectsUnsupportedByConstraint() {
        // 第 3 步起语言是否支持按选中提供者的报价约束查，不在 parse 里写死
        assertCode(BridgeErrors.BAD_PARAMS) { checkAll("""{"text":"a","src":"de","tgt":"fr"}""") }
        assertCode(BridgeErrors.BAD_PARAMS) { checkAll("""{"text":"a","src":"en","tgt":"ja"}""") }
        // 大小写与变体不放行，保持与清单语言码一致
        assertCode(BridgeErrors.BAD_PARAMS) { checkAll("""{"text":"a","src":"zh-cn","tgt":"en"}""") }
        assertCode(BridgeErrors.BAD_PARAMS) { checkAll("""{"text":"a","src":"zh","tgt":"en"}""") }
    }

    @Test
    fun checkLanguages_followsGivenConstraint() {
        val req = parse("""{"text":"a","src":"de","tgt":"en"}""")
        // 某提供者支持德语时放行，同一请求换个不支持的就拒，路由不用改
        AiTranslatePolicy.checkLanguages(req, listOf("de", "en"), sourceAuto = false)
        assertCode(BridgeErrors.BAD_PARAMS) { AiTranslatePolicy.checkLanguages(req, listOf("fr", "en"), sourceAuto = false) }
        val auto = parse("""{"text":"a","src":"auto","tgt":"en"}""")
        AiTranslatePolicy.checkLanguages(auto, listOf("en", "fr"), sourceAuto = true)
        assertCode(BridgeErrors.BAD_PARAMS) { AiTranslatePolicy.checkLanguages(auto, listOf("en", "fr"), sourceAuto = false) }
    }

    @Test
    fun parse_rejectsSameLanguage() {
        assertCode(BridgeErrors.BAD_PARAMS) { parse("""{"text":"a","src":"en","tgt":"en"}""") }
    }

    @Test
    fun parse_rejectsBadBeams() {
        assertCode(BridgeErrors.BAD_PARAMS) { parse("""{"text":"a","src":"en","tgt":"fr","numBeams":0}""") }
        assertCode(BridgeErrors.BAD_PARAMS) { parse("""{"text":"a","src":"en","tgt":"fr","numBeams":5}""") }
        assertCode(BridgeErrors.BAD_PARAMS) { parse("""{"text":"a","src":"en","tgt":"fr","numBeams":-1}""") }
        assertCode(BridgeErrors.BAD_PARAMS) { parse("""{"text":"a","src":"en","tgt":"fr","numBeams":2.5}""") }
        assertCode(BridgeErrors.BAD_PARAMS) { parse("""{"text":"a","src":"en","tgt":"fr","numBeams":"2"}""") }
        assertCode(BridgeErrors.BAD_PARAMS) { parse("""{"text":"a","src":"en","tgt":"fr","numBeams":99999999999}""") }
    }

    @Test
    fun parse_provider_optionalStringOnly() {
        assertNull(parse("""{"text":"a","src":"en","tgt":"fr"}""").provider)
        assertEquals("local-qwen", parse("""{"text":"a","src":"en","tgt":"fr","provider":"local-qwen"}""").provider)
        assertCode(BridgeErrors.BAD_PARAMS) { parse("""{"text":"a","src":"en","tgt":"fr","provider":1}""") }
        assertCode(BridgeErrors.BAD_PARAMS) { parse("""{"text":"a","src":"en","tgt":"fr","provider":""}""") }
        // 与其它入口一样限 ${AiPolicy.MAX_ID} 字
        val tooLong = "p".repeat(AiPolicy.MAX_ID + 1)
        assertCode(BridgeErrors.BAD_PARAMS) { parse("""{"text":"a","src":"en","tgt":"fr","provider":"$tooLong"}""") }
    }

    @Test
    fun resultJson_hasAllFields() {
        val j = AiTranslatePolicy.resultJson(TranslateResult("Hello", 1234, "nllb600m-un6-mnn-w6", "zh-CN", "en"))
        assertEquals("Hello", j.getString("text"))
        assertEquals(1234L, j.getLong("elapsedMs"))
        assertEquals("nllb600m-un6-mnn-w6", j.getString("modelId"))
        assertEquals("zh-CN", j.getString("src"))
        assertEquals("en", j.getString("tgt"))
        assertEquals(listOf("zh-CN"), List(j.getJSONArray("detectedSrc").length()) { j.getJSONArray("detectedSrc").getString(it) })
        assertEquals(false, j.getBoolean("unrecognized"))
        assertEquals(7, j.length())
    }

    @Test
    fun resultJson_autoCarriesDetectedAndUnrecognized() {
        val j = AiTranslatePolicy.resultJson(TranslateResult("Hi. 😀", 5, "m", "auto", "en", listOf("fr", "zh-CN"), true))
        assertEquals("auto", j.getString("src"))
        assertEquals("fr", j.getJSONArray("detectedSrc").getString(0))
        assertEquals("zh-CN", j.getJSONArray("detectedSrc").getString(1))
        assertEquals(true, j.getBoolean("unrecognized"))
        assertEquals(0, AiTranslatePolicy.resultJson(TranslateResult("x", 1, "m", "auto", "en", emptyList(), true)).getJSONArray("detectedSrc").length())
    }

    @Test
    fun parse_autoSourceIsAllowedWithAnyTarget() {
        AiTranslatePolicy.LANGS.forEach { t ->
            assertEquals(AiTranslateRequest("x", "auto", t, null), parse("""{"text":"x","src":"auto","tgt":"$t"}"""))
        }
    }

    @Test
    fun parse_autoTargetRejected() {
        listOf(
            """{"text":"x","src":"en","tgt":"auto"}""",
            """{"text":"x","src":"auto","tgt":"auto"}""",
        ).forEach { json ->
            val e = assertThrows(BridgeException::class.java) { parse(json) }
            assertEquals(BridgeErrors.BAD_PARAMS, e.code)
        }
    }

    @Test
    fun checkLanguages_badSourceOrTargetRejected() {
        listOf(
            """{"text":"x","src":"AUTO","tgt":"en"}""",
            """{"text":"x","src":"de","tgt":"en"}""",
            """{"text":"x","src":"auto","tgt":"de"}""",
        ).forEach { json ->
            val e = assertThrows(BridgeException::class.java) { checkAll(json) }
            assertEquals(BridgeErrors.BAD_PARAMS, e.code)
        }
    }
}
