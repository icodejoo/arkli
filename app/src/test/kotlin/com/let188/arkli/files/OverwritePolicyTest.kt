package com.let188.arkli.files

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 覆盖原图的格式校验与选图 URI 识别测试 */
class OverwritePolicyTest {
    @Test
    fun sameFormatAcceptsMatchingMimeAndExt() {
        assertTrue(OverwritePolicy.sameFormat("image/jpeg", "stitch_1.jpg"))
        assertTrue(OverwritePolicy.sameFormat("image/jpeg", "a.JPEG"))
        assertTrue(OverwritePolicy.sameFormat("image/png", "a.png"))
        assertTrue(OverwritePolicy.sameFormat("image/webp", "a.webp"))
    }

    @Test
    fun sameFormatNormalizesAliasesAndParams() {
        assertTrue(OverwritePolicy.sameFormat("image/jpg", "a.jpg"))
        assertTrue(OverwritePolicy.sameFormat("image/pjpeg", "a.jpg"))
        assertTrue(OverwritePolicy.sameFormat("IMAGE/PNG; charset=binary", "a.png"))
        assertTrue(OverwritePolicy.sameFormat("image/x-png", "a.png"))
    }

    @Test
    fun sameFormatRejectsMismatch() {
        assertFalse(OverwritePolicy.sameFormat("image/jpeg", "a.png"))
        assertFalse(OverwritePolicy.sameFormat("image/png", "a.jpg"))
        assertFalse(OverwritePolicy.sameFormat("image/heic", "a.jpg"))
        assertFalse(OverwritePolicy.sameFormat("image/webp", "a.jpg"))
    }

    @Test
    fun sameFormatRejectsUnknownSides() {
        assertFalse(OverwritePolicy.sameFormat(null, "a.jpg"))
        assertFalse(OverwritePolicy.sameFormat("", "a.jpg"))
        assertFalse(OverwritePolicy.sameFormat("image/jpeg", "noext"))
        assertFalse(OverwritePolicy.sameFormat("image/jpeg", "a.xyz"))
    }

    @Test
    fun mediaIdFromDocumentUri() {
        assertEquals(47L, OverwritePolicy.mediaId("content://com.android.providers.media.documents/document/image%3A47"))
        assertEquals(47L, OverwritePolicy.mediaId("content://com.android.providers.media.documents/document/image:47"))
        assertEquals(9L, OverwritePolicy.mediaId("content://com.android.providers.media.documents/tree/x/document/image%3A9"))
    }

    @Test
    fun mediaIdFromPickerAndMediaStoreUri() {
        assertEquals(1234L, OverwritePolicy.mediaId("content://media/picker/0/com.android.providers.media.photopicker/media/1234"))
        assertEquals(5L, OverwritePolicy.mediaId("content://media/external/images/media/5"))
        assertEquals(6L, OverwritePolicy.mediaId("content://media/external_primary/images/media/6"))
    }

    @Test
    fun mediaIdRejectsNonImageAndOtherProviders() {
        assertNull(OverwritePolicy.mediaId("content://com.android.providers.media.documents/document/video%3A47"))
        assertNull(OverwritePolicy.mediaId("content://com.android.providers.media.documents/document/audio%3A47"))
        assertNull(OverwritePolicy.mediaId("content://com.android.externalstorage.documents/document/primary%3APictures%2Fa.jpg"))
        assertNull(OverwritePolicy.mediaId("content://media/external/video/media/5"))
        assertNull(OverwritePolicy.mediaId("content://media/external/images/media/abc"))
        assertNull(OverwritePolicy.mediaId("file:///sdcard/a.jpg"))
    }
}
