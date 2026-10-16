package com.let188.arkli.ai

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** 识物纯逻辑：参数校验、词表解析、像素转换、结果序列化（选提供者见 AiRouterTest） */
class AiClassifyPolicyTest {
    /** 最小合法词表 JSON */
    private fun vocabJson(count: Int = 2, format: Int = 1, dtype: String = "f16le", category: String = "R") = """
        {"format":$format,"note":"草稿","dtype":"$dtype","dim":2,"count":$count,
         "categories":{"R":"可回收物","D":"干垃圾"},
         "items":[{"id":"a","nameZh":"甲","nameEn":"a","category":"R"},
                  {"id":"b","nameZh":"乙","nameEn":"b","category":"$category"}]}
    """.trimIndent()

    /** 断言抛指定错误码 */
    private fun assertCode(code: String, block: () -> Unit) {
        val e = assertThrows(BridgeException::class.java) { block() }
        assertEquals(code, e.code)
    }

    @Test
    fun parse_defaults() {
        val r = AiClassifyPolicy.parse(JSONObject("""{"path":"cache/pick/a.jpg"}"""))
        assertEquals(AiClassifyRequest(null, "cache/pick/a.jpg", 3), r)
    }

    @Test
    fun parse_full() {
        val r = AiClassifyPolicy.parse(JSONObject("""{"provider":"local-clip","path":"cache/a.png","topK":5}"""))
        assertEquals(AiClassifyRequest("local-clip", "cache/a.png", 5), r)
        // provider 显式为 null 等同于没传
        assertNull(AiClassifyPolicy.parse(JSONObject("""{"provider":null,"path":"p"}""")).provider)
    }

    @Test
    fun parse_rejectsBad() {
        listOf(
            """{}""",
            """{"path":5}""",
            """{"path":"  "}""",
            """{"path":"p","provider":5}""",
            """{"path":"p","provider":""}""",
            """{"path":"p","topK":0}""",
            """{"path":"p","topK":11}""",
            """{"path":"p","topK":2.5}""",
            """{"path":"p","topK":"3"}""",
            """{"path":"p","topK":99999999999}""",
        ).forEach { js -> assertCode(BridgeErrors.BAD_PARAMS) { AiClassifyPolicy.parse(JSONObject(js)) } }
        val longPath = "a".repeat(AiClassifyPolicy.MAX_PATH + 1)
        assertCode(BridgeErrors.BAD_PARAMS) { AiClassifyPolicy.parse(JSONObject().put("path", longPath)) }
    }

    @Test
    fun parseVocab_ok() {
        val m = AiClassifyPolicy.parseVocab(vocabJson())
        assertEquals(2, m.dim)
        assertEquals(listOf("a", "b"), m.items.map { it.id })
        assertEquals("可回收物", m.categoryNames["R"])
        assertEquals("草稿", m.note)
    }

    @Test
    fun parseVocab_rejectsBad() {
        listOf(
            vocabJson(format = 2),
            vocabJson(dtype = "f32"),
            vocabJson(count = 3),
            vocabJson(category = "X"),
            "not json",
            """{"format":1}""",
        ).forEach { js -> assertThrows(IllegalArgumentException::class.java) { AiClassifyPolicy.parseVocab(js) } }
    }

    @Test
    fun checkVocabVectors_length() {
        val m = AiClassifyPolicy.parseVocab(vocabJson())
        AiClassifyPolicy.checkVocabVectors(m, ByteArray(2 * 2 * 2))
        assertThrows(IllegalArgumentException::class.java) { AiClassifyPolicy.checkVocabVectors(m, ByteArray(7)) }
    }

    /** 随包词表资源必须与解析器、字节数一致（读 assets 里的真文件） */
    @Test
    fun bundledVocab_isConsistent() {
        val dir = File("src/main/assets/ai")
        val meta = AiClassifyPolicy.parseVocab(File(dir, "garbage_vocab.json").readText())
        AiClassifyPolicy.checkVocabVectors(meta, File(dir, "garbage_vocab.f16").readBytes())
        assertEquals(768, meta.dim)
        assertEquals(182, meta.items.size)
        assertEquals(setOf("R", "H", "W", "D"), meta.categoryNames.keys)
        assertTrue("文件头要保留草稿提示", meta.note.contains("草稿"))
        assertEquals("id 必须唯一", meta.items.size, meta.items.map { it.id }.toSet().size)
    }

    @Test
    fun argbToRgb_opaqueAndTransparent() {
        val px = intArrayOf(0xFF102030.toInt(), 0x00000000, 0x80FF0000.toInt())
        val rgb = AiClassifyPolicy.argbToRgb(px)
        // 不透明原样
        assertArrayEquals(byteArrayOf(0x10, 0x20, 0x30), rgb.copyOfRange(0, 3))
        // 全透明 -> 白
        assertArrayEquals(byteArrayOf(-1, -1, -1), rgb.copyOfRange(3, 6))
        // 50% 红叠白：R=255，G=B=(255*127+127)/255=127
        assertEquals(255, rgb[6].toInt() and 0xFF)
        assertEquals(127, rgb[7].toInt() and 0xFF)
        assertEquals(127, rgb[8].toInt() and 0xFF)
    }

    @Test
    fun resultJson_shape() {
        val meta = AiClassifyPolicy.parseVocab(vocabJson())
        val outcome = ClassifyOutcome(
            listOf(ClassifyHit(1, 0.123456f), ClassifyHit(0, 0.1f)),
            listOf(CategoryProb("D", 0.9f), CategoryProb("R", 0.1f)),
            0.9f,
            false,
        )
        val j = AiClassifyPolicy.resultJson(ClassifyResult(meta, outcome, "m", 1234, 1000))
        val first = j.getJSONArray("items").getJSONObject(0)
        assertEquals("b", first.getString("id"))
        assertEquals("乙", first.getString("nameZh"))
        assertEquals("R", first.getString("category"))
        assertEquals(0.1235, first.getDouble("score"), 1e-9)
        val c0 = j.getJSONArray("categories").getJSONObject(0)
        assertEquals("D", c0.getString("category"))
        assertEquals("干垃圾", c0.getString("name"))
        assertEquals(0.9, j.getDouble("confidence"), 1e-9)
        assertFalse(j.getBoolean("uncertain"))
        assertEquals(1234L, j.getLong("elapsedMs"))
        assertEquals(1000L, j.getLong("inferMs"))
        assertEquals("m", j.getString("modelId"))
    }
}
