package sh.vyre.app.api

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

/** The box's shapes are loose (CONTRACT.md: what run() returns). Read them with these, never crash on a missing key. */
val JsonCodec = Json { ignoreUnknownKeys = true; isLenient = false; explicitNulls = false }

val JsonElement?.obj: JsonObject get() = this as? JsonObject ?: JsonObject(emptyMap())
val JsonElement?.arr: JsonArray get() = this as? JsonArray ?: JsonArray(emptyList())

fun JsonElement?.str(key: String): String? = ((this as? JsonObject)?.get(key) as? JsonPrimitive)?.takeIf { it !is JsonNull }?.let {
    if (it.isString) it.content else it.content
}
fun JsonElement?.long(key: String): Long? = ((this as? JsonObject)?.get(key) as? JsonPrimitive)?.let { it.longOrNull ?: it.doubleOrNull?.toLong() }
fun JsonElement?.double(key: String): Double? = ((this as? JsonObject)?.get(key) as? JsonPrimitive)?.doubleOrNull
fun JsonElement?.bool(key: String): Boolean? = ((this as? JsonObject)?.get(key) as? JsonPrimitive)?.booleanOrNull
fun JsonElement?.at(key: String): JsonElement? = (this as? JsonObject)?.get(key)?.takeIf { it !is JsonNull }
fun JsonElement?.strings(key: String): List<String> = at(key).let { v ->
    when (v) {
        is JsonArray -> v.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p !is JsonNull }?.content }
        is JsonPrimitive -> listOf(v.content)
        else -> emptyList()
    }
}

/** Build a tool input. Null values are left out (canonical() drops undefined; a null would be kept). */
fun input(vararg pairs: Pair<String, Any?>): JsonObject = buildJsonObject { for ((k, v) in pairs) put(k, v) }

fun JsonObjectBuilder.put(k: String, v: Any?) {
    val e = toJson(v) ?: return
    put(k, e)
}

fun toJson(v: Any?): JsonElement? = when (v) {
    null -> null
    is JsonElement -> v
    is String -> JsonPrimitive(v)
    is Boolean -> JsonPrimitive(v)
    is Number -> JsonPrimitive(v)
    is Map<*, *> -> JsonObject(v.entries.mapNotNull { (k, x) -> toJson(x)?.let { k.toString() to it } }.toMap())
    is List<*> -> JsonArray(v.map { toJson(it) ?: JsonNull })
    else -> JsonPrimitive(v.toString())
}

/**
 * History events from threads.get carry their fields under `payload`; live stream events carry
 * payload plus thread/project beside it. One flat map for both (CONTRACT.md 3.4: flatten it yourself).
 */
fun flatten(ev: JsonElement): JsonObject {
    val o = ev.obj
    val out = LinkedHashMap<String, JsonElement>()
    // The event's own id becomes `event`; a payload `id` (a tool call's id, a gate item's id) keeps `id`.
    for ((k, v) in o) if (k != "payload") out[if (k == "id") "event" else k] = v
    for ((k, v) in o["payload"].obj) out[k] = v
    return JsonObject(out)
}
