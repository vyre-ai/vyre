package sh.vyre.app.data

import kotlinx.serialization.json.JsonElement
import sh.vyre.app.api.str
import sh.vyre.app.api.strings

/**
 * One row of Now's "Needs you" card (phone.md section 4): a held draft or a session's ask, read
 * the same way. Pure, so it is tested on the JVM.
 */
data class Need(
    val kind: Kind,
    val id: String,
    /** Line 1: the action ("Push q3-report", "Send email to Dana"). */
    val title: String,
    /** Line 2: the command for an ask (mono), the subject for a draft. */
    val line: String,
    val agent: String?,
    val project: String?,
    val at: Long?,
    val thread: String?,
    val raw: JsonElement,
) {
    enum class Kind { Ask, Draft }
    /** The swipe-right verb and the swipe-left one. */
    val yes: String get() = if (kind == Kind.Draft && raw.str("kind") == "send") "Send" else "Approve"
    val no: String get() = if (kind == Kind.Draft) "Discard" else "Deny"
    /** The tile's letter: the agent that asked. */
    val initial: String get() = (agent ?: "V").take(1).uppercase()
}

object Needs {
    /** Held items and asks together, oldest first. `agentOf` and `projectOf` read an ask's thread. */
    fun rows(held: List<JsonElement>, asks: List<JsonElement>, agentOf: (String?) -> String?, projectOf: (String?) -> String?): List<Need> {
        val out = mutableListOf<Need>()
        for (h in held) {
            val id = h.str("id") ?: continue
            out += Need(Need.Kind.Draft, id, draftTitle(h), h.str("summary").orEmpty(), h.str("agent"), h.str("project"), h.str("at")?.toLongOrNull(), h.str("thread"), h)
        }
        for (a in asks) {
            val id = a.str("id") ?: continue
            val t = a.str("thread")
            out += Need(Need.Kind.Ask, id, askTitle(a.str("tool"), a.str("summary"), a.str("destination")), askLine(a.str("tool"), a.str("summary"), a.str("destination")),
                agentOf(t), projectOf(t), a.str("at")?.toLongOrNull(), t, a)
        }
        return out.sortedBy { it.at ?: Long.MAX_VALUE }
    }

    /** "Send email to Dana", "Send email to Dana and 2 others", "Send to #ops", "Approve a spend", "Delete a record". */
    fun draftTitle(h: JsonElement): String {
        val to = h.strings("to")
        return when (h.str("kind")) {
            "send" -> {
                val first = to.firstOrNull()
                val who = if (first != null && '@' in first) person(first) else first
                val more = if (to.size > 1) " and ${to.size - 1} other${if (to.size > 2) "s" else ""}" else ""
                when {
                    who == null -> "Send a message"
                    first != null && '@' in first -> "Send email to $who$more"
                    else -> "Send to $who$more"
                }
            }
            "spend" -> "Approve a spend"
            "delete" -> "Approve a delete"
            else -> h.str("summary") ?: "Approve"
        }
    }

    /** "dana@harlowlegal.com" reads "Dana"; "dana.reyes@..." reads "Dana". */
    fun person(email: String): String = email.substringBefore('@').split('.', '_', '-', '+').firstOrNull { it.isNotBlank() }
        ?.replaceFirstChar { it.uppercase() } ?: email

    /** The ask's action in plain words: "Push q3-report", "Run npm test", "Edit report.tsx", "Fetch api.example.com". */
    fun askTitle(tool: String?, summary: String?, destination: String?): String {
        val s = summary.orEmpty().trim()
        val base = destination?.substringAfterLast('/')?.ifBlank { null }
        return when (tool) {
            "Bash" -> command(s)
            "Write" -> "Write ${base ?: s.substringAfter(' ').substringAfterLast('/')}"
            "Edit", "MultiEdit", "NotebookEdit" -> "Edit ${base ?: s.substringAfter(' ').substringAfterLast('/')}"
            "Read" -> "Read ${base ?: s.substringAfter(' ').substringAfterLast('/')}"
            "WebFetch" -> "Fetch " + (Regex("https?://([^/\\s]+)").find(s)?.groupValues?.get(1) ?: s.removePrefix("fetch ").take(60))
            null, "" -> s.take(60).ifEmpty { "Run a tool" }
            else -> "Use $tool"
        }
    }

    /** Line 2 of an ask: the command for Bash, else the path or what it touches. */
    fun askLine(tool: String?, summary: String?, destination: String?): String =
        if (tool == "Bash" || destination == null) summary.orEmpty() else destination

    private fun command(cmd: String): String {
        val w = cmd.split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (w.isEmpty()) return "Run a command"
        val args = w.drop(1).filterNot { it.startsWith("-") }
        return when {
            w[0] == "git" && args.firstOrNull() == "push" -> "Push " + (args.drop(1).lastOrNull() ?: "commits")
            w[0] == "git" && args.firstOrNull() == "commit" -> "Commit changes"
            w[0] == "git" && args.isNotEmpty() -> "Git ${args[0]}"
            w[0] == "rm" -> "Delete " + (args.lastOrNull()?.substringAfterLast('/') ?: "files")
            w[0] in setOf("npm", "pnpm", "yarn", "bun") && args.firstOrNull() == "run" && args.size > 1 -> "Run ${w[0]} ${args[1]}"
            w[0] in setOf("npm", "pnpm", "yarn", "bun") && args.isNotEmpty() -> "Run ${w[0]} ${args[0]}"
            w[0] == "curl" || w[0] == "wget" -> "Fetch " + (Regex("https?://([^/\\s]+)").find(cmd)?.groupValues?.get(1) ?: "a URL")
            else -> "Run ${w[0]}"
        }
    }

    /** "12m", "3h", "2d": time since it was held, the row's short form. */
    fun short(at: Long?, now: Long = System.currentTimeMillis()): String {
        if (at == null || at <= 0) return ""
        val s = ((now - at) / 1000).coerceAtLeast(0)
        return when { s < 60 -> "now"; s < 3600 -> "${s / 60}m"; s < 86400 -> "${s / 3600}h"; else -> "${s / 86400}d" }
    }

    /** "4 minutes ago", for what TalkBack reads. */
    fun spoken(at: Long?, now: Long = System.currentTimeMillis()): String {
        if (at == null || at <= 0) return ""
        val s = ((now - at) / 1000).coerceAtLeast(0)
        fun n(v: Long, unit: String) = "$v $unit${if (v == 1L) "" else "s"} ago"
        return when { s < 60 -> "just now"; s < 3600 -> n(s / 60, "minute"); s < 86400 -> n(s / 3600, "hour"); else -> n(s / 86400, "day") }
    }

    /**
     * What TalkBack reads for a row (phone.md section 12): "kit, Harlow Legal, wants to push
     * q3-report, git push origin q3-report, 4 minutes ago."
     */
    fun label(n: Need, now: Long = System.currentTimeMillis()): String {
        val wants = "wants to " + n.title.replaceFirstChar { it.lowercase() }
        return listOfNotNull(n.agent, n.project, wants, n.line.takeIf { it.isNotBlank() }, spoken(n.at, now).takeIf { it.isNotEmpty() })
            .joinToString(", ") + "."
    }
}
