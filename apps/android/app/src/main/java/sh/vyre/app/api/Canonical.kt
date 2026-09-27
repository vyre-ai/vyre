package sh.vyre.app.api

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.math.BigDecimal
import java.security.MessageDigest
import java.util.Base64

/**
 * Canonical JSON, byte for byte what core/presence/index.js `canonical()` makes: object keys
 * sorted at every depth (UTF-16 code unit order, as Array.prototype.sort does), no spaces,
 * strings escaped as JSON.stringify escapes them, numbers written as JavaScript writes them.
 * A presence proof is bound to the SHA-256 of this, so one byte off and the box refuses it.
 */
object Canonical {
    fun encode(v: JsonElement): String = StringBuilder().also { write(v, it) }.toString()

    /** base64url (no padding) SHA-256 of the canonical form: the `inputHash` the box checks. */
    fun hash(v: JsonElement): String = b64url(MessageDigest.getInstance("SHA-256").digest(encode(v).toByteArray(Charsets.UTF_8)))

    private fun write(v: JsonElement, out: StringBuilder) {
        when (v) {
            is JsonNull -> out.append("null")
            is JsonObject -> {
                out.append('{')
                var first = true
                for (k in v.keys.sorted()) {
                    if (!first) out.append(',')
                    first = false
                    string(k, out); out.append(':'); write(v.getValue(k), out)
                }
                out.append('}')
            }
            is JsonArray -> {
                out.append('[')
                v.forEachIndexed { i, x -> if (i > 0) out.append(','); write(x, out) }
                out.append(']')
            }
            is JsonPrimitive -> when {
                v.isString -> string(v.content, out)
                v.content == "true" || v.content == "false" -> out.append(v.content)
                else -> out.append(number(v.content))
            }
        }
    }

    /** JSON.stringify's string escaping: quote, backslash, the short escapes, other C0 as \u00xx, lone surrogates as \udxxx. */
    fun string(s: String, out: StringBuilder) {
        out.append('"')
        var i = 0
        while (i < s.length) {
            val ch = s[i]
            when {
                ch == '"' -> out.append("\\\"")
                ch == '\\' -> out.append("\\\\")
                ch == '\b' -> out.append("\\b")
                ch == '\u000C' -> out.append("\\f")
                ch == '\n' -> out.append("\\n")
                ch == '\r' -> out.append("\\r")
                ch == '\t' -> out.append("\\t")
                ch < ' ' -> out.append("\\u").append(hex4(ch.code))
                Character.isHighSurrogate(ch) -> {
                    if (i + 1 < s.length && Character.isLowSurrogate(s[i + 1])) { out.append(ch).append(s[i + 1]); i++ }
                    else out.append("\\u").append(hex4(ch.code))
                }
                Character.isLowSurrogate(ch) -> out.append("\\u").append(hex4(ch.code))
                else -> out.append(ch)
            }
            i++
        }
        out.append('"')
    }

    private fun hex4(n: Int) = n.toString(16).padStart(4, '0')

    /**
     * A number as JavaScript's Number#toString writes it: integers plain below 1e21, the shortest
     * round-trip digits otherwise, with an exponent (e+21, e-7) outside [1e-6, 1e21).
     */
    fun number(raw: String): String {
        val d = raw.toDoubleOrNull() ?: return "null"
        if (d.isNaN() || d.isInfinite()) return "null"
        if (d == 0.0) return "0"
        val r = shortest(d).stripTrailingZeros()
        val digits = r.unscaledValue().abs().toString()
        val k = digits.length
        val n = k - r.scale()
        val sb = StringBuilder()
        if (r.signum() < 0) sb.append('-')
        when {
            n in k..21 -> { sb.append(digits); repeat(n - k) { sb.append('0') } }
            n in 1..21 -> sb.append(digits, 0, n).append('.').append(digits, n, k)
            n in -5..0 -> { sb.append("0."); repeat(-n) { sb.append('0') }; sb.append(digits) }
            else -> {
                val e = n - 1
                sb.append(digits[0])
                if (k > 1) sb.append('.').append(digits, 1, k)
                sb.append('e').append(if (e >= 0) '+' else '-').append(kotlin.math.abs(e))
            }
        }
        return sb.toString()
    }

    /** The shortest decimal that reads back as the same double (the JVM's Double.toString is that on 19+, close to it before). */
    private fun shortest(d: Double): BigDecimal {
        val bd = BigDecimal(d.toString())
        for (p in 1..17) {
            val r = bd.round(java.math.MathContext(p))
            if (r.toDouble() == d) return r
        }
        return bd
    }
}

fun b64url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
fun unb64url(s: String): ByteArray = Base64.getUrlDecoder().decode(s)
