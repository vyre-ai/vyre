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

    /**
     * What the fingerprint sheet says (ADR 0004: the destination and the start of the final
     * content): "Send to dana@harlowlegal.com: Invoice for March. Hi Dana, ...". At most 120 characters.
     */
    fun reason(item: JsonElement?, verb: String): String {
        val to = item.strings("to").joinToString(", ")
        val c = content(item)
        val words = listOfNotNull(c.str("subject") ?: item.str("summary"), c.str("body")?.replace(Regex("\\s+"), " ")?.trim())
            .filter { it.isNotEmpty() }.distinct().joinToString(". ")
        val head = if (to.isNotEmpty()) "$verb to $to" else verb
        val out = if (words.isEmpty()) head else "$head: $words"
        return if (out.length <= 120) out else out.take(119).trimEnd() + "\u2026"
    }

    /**
     * The final words, whole, as the person reads them before a swipe sends (floor rules 1 and 2):
     * where it goes first, then every field of `final ?? draft`. What gate.approve sends with no
     * `edited` is exactly this.
     */
    fun finalWords(item: JsonElement?): List<HeldField> = fields(item)

    /**
     * A fingerprint of what was shown: destination and final content, canonical. The app reads the
     * item again after the proof and sends only if this is unchanged, so a revision that lands
     * while the person reads is never sent unseen.
     */
    fun shown(item: JsonElement?): String = sh.vyre.app.api.Canonical.encode(JsonObject(mapOf(
        "to" to JsonArray(item.strings("to").map(::JsonPrimitive)), "content" to content(item), "state" to JsonPrimitive(item.str("state") ?: "held"))))

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
