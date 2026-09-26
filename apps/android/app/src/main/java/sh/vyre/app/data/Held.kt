package sh.vyre.app.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import sh.vyre.app.api.JsonCodec
import sh.vyre.app.api.at
import sh.vyre.app.api.obj
import sh.vyre.app.api.str
import sh.vyre.app.api.strings

/** One editable field of a held item: it reads as text and becomes editable on tap. */
data class HeldField(val key: String, val label: String, val original: String, val json: Boolean, val multiline: Boolean)

/**
 * A held item's words as fields, the Deck's order (deck/js/editable.js): To first, then subject,
 * cc, bcc, method, url, headers, any other key, body last. Strings edit as text, anything else as
 * pretty JSON parsed back on send.
 */
object Held {
    private val ORDER = listOf("subject", "cc", "bcc", "method", "url", "headers")
    private val pretty = Json { prettyPrint = true; prettyPrintIndent = "  " }

    fun content(item: JsonElement?): JsonObject = (item.at("final") ?: item.at("draft")).obj

    fun fields(item: JsonElement?): List<HeldField> {
        val c = content(item)
        val out = mutableListOf(HeldField("to", "To", item.strings("to").joinToString(", "), json = false, multiline = false))
        val keys = c.keys.toList()
        val ordered = ORDER.filter { it in keys } + keys.filter { it !in ORDER && it != "body" } + listOf("body").filter { it in keys }
        for (k in ordered) {
            val v = c[k] ?: continue
            val (text, json) = when {
                v is JsonPrimitive && v.isString -> v.content to false
                v is JsonNull -> "" to false
                else -> pretty.encodeToString(JsonElement.serializer(), v) to true
            }
            out += HeldField(k, label(k), text, json, multiline = k == "body" || k == "headers" || json || text.contains('\n'))
        }
        return out
    }

    fun label(k: String) = when (k) { "url" -> "URL"; "cc" -> "Cc"; "bcc" -> "Bcc"; else -> k.replaceFirstChar { it.uppercase() } }

    /**
     * gate.approve's `edited`: only the fields whose text changed, or null when nothing did.
     * `to` goes back as a list. JSON fields must parse, else [IllegalArgumentException] names the field.
     */
    fun edited(fields: List<HeldField>, now: Map<String, String>): JsonObject? {
        val out = LinkedHashMap<String, JsonElement>()
        for (f in fields) {
            val v = now[f.key] ?: continue
            if (v == f.original) continue
            out[f.key] = when {
                f.key == "to" -> JsonArray(v.split(',').map { it.trim() }.filter { it.isNotEmpty() }.map(::JsonPrimitive))
                f.json -> if (v.isBlank()) JsonNull else try { JsonCodec.parseToJsonElement(v) } catch (e: Exception) { throw IllegalArgumentException("${f.label} is not valid JSON") }
                else -> JsonPrimitive(v)
            }
        }
        return if (out.isEmpty()) null else JsonObject(out)
    }

    /** "Send" for a held email, "Approve" for a spend or delete (deck/js/needs.js). */
    fun action(kind: String?) = if (kind == "send") "Send" else "Approve"

    /** What the fingerprint sheet says: the item's summary, with where it goes. */
    fun reason(item: JsonElement?, verb: String): String {
        val to = item.strings("to").joinToString(", ")
        val s = item.str("summary").orEmpty()
        return "$verb: " + listOf(s, to.takeIf { it.isNotEmpty() }?.let { "to $it" }).filterNotNull().filter { it.isNotEmpty() }.joinToString(" ")
    }

    /** The heading a held item reads as: "Email to Dana Reyes", "POST api.example.com". */
    fun title(brief: JsonElement?): String {
        val kind = brief.str("kind")
        val to = brief.strings("to")
        return when (kind) {
            "send" -> if (brief.str("via")?.let { it == "mail" || it.contains("mail") } == true || to.any { '@' in it }) "Email to ${to.joinToString(", ").ifEmpty { "someone" }}" else "Send to ${to.joinToString(", ")}"
            "spend" -> "Spend: ${brief.str("summary").orEmpty()}"
            "delete" -> "Delete: ${brief.str("summary").orEmpty()}"
            else -> brief.str("summary").orEmpty()
        }
    }
}
