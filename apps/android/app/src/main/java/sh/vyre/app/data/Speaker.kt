package sh.vyre.app.data

import kotlinx.serialization.json.JsonElement
import sh.vyre.app.api.at
import sh.vyre.app.api.str

/**
 * Who a turn is by, as the person reads it (a user rule): the user's own messages are "you", an
 * agent's are its name, and a reply is by the thread's agent, or else the assistant, named from
 * agents.list (kind "assistant") or system.info, or "Vyre". The model's maker never appears: a
 * name that says "claude" is replaced, and model ids lose it. Pure, so it is tested on the JVM.
 */
object Speaker {
    const val FALLBACK = "Vyre"
    const val YOU = "you"

    /** The assistant's name: agents.list's assistant, then system.info's (`assistant` or `assistant.name`), then "Vyre". */
    fun assistant(agents: List<JsonElement>, info: JsonElement? = null): String =
        listOf(
            agents.firstOrNull { it.str("kind") == "assistant" }?.str("name"),
            info.at("assistant")?.let { a -> a.str("name") ?: (a as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content },
        ).firstOrNull { ok(it) } ?: FALLBACK

    /** Who wrote a reply in a thread: the thread's agent, or the assistant when no agent ran it. */
    fun reply(threadAgent: String?, assistant: String): String = threadAgent?.takeIf { ok(it) } ?: assistant.takeIf { ok(it) } ?: FALLBACK

    /** Who typed a message: an agent (thread.sent surface `agent:<name>`) by its name, anyone else is the user. */
    fun sender(surface: String?, assistant: String): String {
        val agent = surface?.takeIf { it.startsWith("agent:") }?.removePrefix("agent:")?.trim() ?: return YOU
        return if (ok(agent)) agent else assistant.takeIf { ok(it) } ?: FALLBACK
    }

    /** A model id as shown: without the maker's name ("claude-sonnet-4-5" reads "sonnet-4-5"). */
    fun model(id: String?): String? = id?.replace(Regex("(?i)claude[-_ ]?"), "")?.trim('-', '_', ' ')?.ifEmpty { null }

    private fun ok(name: String?): Boolean = !name.isNullOrBlank() && !name.contains("claude", ignoreCase = true)
}
