package com.let188.arkli.image

import com.let188.arkli.bridge.BridgeErrors
import com.let188.arkli.bridge.BridgeException
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** 拼接布局（与 web image-calc.test.ts 的 stitchLayout 用例对拍）与参数校验测试 */
class StitchLayoutTest {
    /** 与 web 用例相同的两张图 */
    private val sizes = listOf(ImageMath.Size(100, 50), ImageMath.Size(200, 80))

    /** 简写 */
    private fun layout(s: List<ImageMath.Size>, v: Boolean, gap: Int, unify: Boolean, a: StitchAlign) =
        StitchLayout.compute(s, v, gap, unify, a)

    @Test
    fun verticalUnifyScalesToNarrowestAndCountsGap() {
        val l = layout(sizes, true, 10, true, StitchAlign.START)
        assertEquals(100, l.width)
        assertEquals(50 + 10 + 40, l.height)
        assertEquals(StitchRect(0, 60, 100, 40), l.items[1])
    }

    @Test
    fun verticalNoUnifyAlignsCrossAxis() {
        val c = layout(sizes, true, 0, false, StitchAlign.CENTER)
        assertEquals(200, c.width)
        assertEquals(50, c.items[0].x)
        assertEquals(0, c.items[1].x)
        assertEquals(100, layout(sizes, true, 0, false, StitchAlign.END).items[0].x)
        assertEquals(0, layout(sizes, true, 0, false, StitchAlign.START).items[0].x)
    }

    @Test
    fun horizontalUnifyHeight() {
        val l = layout(sizes, false, 4, true, StitchAlign.START)
        assertEquals(50, l.height)
        assertEquals(StitchRect(0, 0, 100, 50), l.items[0])
        assertEquals(StitchRect(104, 0, 125, 50), l.items[1])
        assertEquals(229, l.width)
    }

    @Test
    fun horizontalNoUnifyAlignsVertically() {
        val c = layout(sizes, false, 0, false, StitchAlign.CENTER)
        assertEquals(80, c.height)
        assertEquals(15, c.items[0].y)
        assertEquals(30, layout(sizes, false, 0, false, StitchAlign.END).items[0].y)
        assertEquals(300, c.width)
    }

    @Test
    fun emptyInput() {
        val l = layout(emptyList(), true, 0, true, StitchAlign.START)
        assertEquals(0, l.width)
        assertEquals(0, l.height)
        assertTrue(l.items.isEmpty())
    }

    @Test
    fun halfRoundsUpLikeJsMathRound() {
        // 宽 4 与宽 2 统一到 2：第一张高 5 * 0.5 = 2.5，JS 四舍五入为 3（银行家舍入会得 2）
        val l = layout(listOf(ImageMath.Size(4, 5), ImageMath.Size(2, 7)), true, 0, true, StitchAlign.START)
        assertEquals(3, l.items[0].h)
        assertEquals(3 + 7, l.height)
    }

    @Test
    fun tinyScaledSideClampsToOne() {
        // 宽 1000 统一到 2：高 1 * 0.002 会舍到 0，必须夹到 1
        val l = layout(listOf(ImageMath.Size(1000, 1), ImageMath.Size(2, 5)), true, 0, true, StitchAlign.START)
        assertEquals(1, l.items[0].h)
    }

    @Test
    fun singleImageAndGapOnlyBetween() {
        val one = layout(listOf(ImageMath.Size(10, 20)), true, 50, true, StitchAlign.START)
        assertEquals(20, one.height)
        val three = layout(List(3) { ImageMath.Size(10, 10) }, true, 5, true, StitchAlign.START)
        assertEquals(30 + 10, three.height)
        assertEquals(20 + 10, three.items[2].y)
    }

    /** 造一份合法参数 */
    private fun params(n: Int = 2): JSONObject =
        JSONObject().put("items", JSONArray().apply { repeat(n) { put(JSONObject().put("path", "cache/pick/$it.jpg")) } }).put("direction", "v")

    /** 断言参数被 BAD_PARAMS 拒绝 */
    private fun assertRejected(p: JSONObject) {
        try {
            StitchPlan.parse(p)
            throw AssertionError("应当被拒绝：$p")
        } catch (e: BridgeException) {
            assertEquals(BridgeErrors.BAD_PARAMS, e.code)
        }
    }

    @Test
    fun parseAppliesDefaults() {
        val p = StitchPlan.parse(params())
        assertTrue(p.vertical)
        assertEquals(0, p.gap)
        assertEquals(0xFFFFFFFF.toInt(), p.bg)
        assertEquals(StitchAlign.CENTER, p.align)
        assertTrue(p.unify)
        assertEquals(OutFormat.PNG, p.format)
        assertEquals(92, p.quality)
    }

    @Test
    fun parseReadsAllFields() {
        val p = StitchPlan.parse(
            params(3).put("direction", "h").put("gap", 200).put("bg", "#12aBcd").put("align", "end")
                .put("unify", false).put("format", "jpeg").put("quality", 0.5),
        )
        assertEquals(3, p.paths.size)
        assertEquals(false, p.vertical)
        assertEquals(200, p.gap)
        assertEquals(0xFF12ABCD.toInt(), p.bg)
        assertEquals(StitchAlign.END, p.align)
        assertEquals(false, p.unify)
        assertEquals(OutFormat.JPEG, p.format)
        assertEquals(50, p.quality)
    }

    @Test
    fun parseItemCountBounds() {
        assertRejected(params(1))
        assertRejected(params(21))
        StitchPlan.parse(params(2))
        StitchPlan.parse(params(20))
    }

    @Test
    fun parseRejectsBadFields() {
        assertRejected(params().put("direction", "x"))
        assertRejected(JSONObject().put("items", params().getJSONArray("items")))
        assertRejected(params().put("gap", -1))
        assertRejected(params().put("gap", 201))
        assertRejected(params().put("gap", 1.5))
        assertRejected(params().put("gap", "3"))
        assertRejected(params().put("bg", "#fff"))
        assertRejected(params().put("bg", "red"))
        assertRejected(params().put("align", "left"))
        assertRejected(params().put("unify", "yes"))
        assertRejected(params().put("format", "webp"))
        assertRejected(params().put("quality", 1.1))
        assertRejected(params().put("quality", -0.1))
        assertRejected(params().put("quality", "0.5"))
        assertRejected(params().put("items", JSONArray().put(JSONObject().put("path", "a")).put(JSONObject())))
        assertRejected(params().put("items", JSONArray().put(JSONObject().put("path", "a")).put("b")))
    }

    @Test
    fun qualityEdgesClampToRange() {
        assertEquals(1, StitchPlan.parse(params().put("quality", 0)).quality)
        assertEquals(100, StitchPlan.parse(params().put("quality", 1)).quality)
    }
}
