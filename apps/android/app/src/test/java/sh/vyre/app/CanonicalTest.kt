package sh.vyre.app

import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import sh.vyre.app.api.Canonical
import sh.vyre.app.api.JsonCodec
import sh.vyre.app.api.arr
import sh.vyre.app.api.input
import sh.vyre.app.api.str

/** Byte for byte against vectors node made with core/presence/index.js (tools/canonical-vectors.mjs). */
class CanonicalTest {
    private val vectors = JsonCodec.parseToJsonElement(javaClass.classLoader!!.getResource("canonical-vectors.json")!!.readText()).arr

    @Test fun matchesTheBoxByteForByte() {
        assertEquals(16, vectors.size)
        for (v in vectors) {
            val parsed = JsonCodec.parseToJsonElement(v.str("input")!!)
            assertEquals(v.str("input"), v.str("canonical"), Canonical.encode(parsed))
        }
    }

    @Test fun hashesMatchTheBox() {
        for (v in vectors) assertEquals(v.str("input"), v.str("hash"), Canonical.hash(JsonCodec.parseToJsonElement(v.str("input")!!)))
    }

    @Test fun numbersReadAsJavaScriptWritesThem() {
        val cases = mapOf("1.0" to "1", "-0" to "0", "1e21" to "1e+21", "1e20" to "100000000000000000000", "1e-7" to "1e-7",
            "0.000001" to "0.000001", "2.50" to "2.5", "123.456" to "123.456", "-1.5e-9" to "-1.5e-9", "1.7976931348623157e308" to "1.7976931348623157e+308")
        for ((raw, js) in cases) assertEquals(raw, js, Canonical.number(raw))
    }

    @Test fun inputLeavesOutNulls() {
        assertEquals("""{"a":1,"c":["x"]}""", Canonical.encode(input("c" to listOf("x"), "b" to null, "a" to 1)))
        assertEquals("\"a\\u0002\"", StringBuilder().also { Canonical.string("a\u0002", it) }.toString())
        assertEquals("\"x\"", Canonical.encode(JsonPrimitive("x")))
    }
}
