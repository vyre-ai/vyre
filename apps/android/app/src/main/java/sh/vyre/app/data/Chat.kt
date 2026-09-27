package sh.vyre.app.data

import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/**
 * How a session reads on the phone (phone.md section 6), the parts with no drawing in them, so
 * they are tested on the JVM: tool rows in plain words, time stamps at the gaps, who holds the
 * keyboard.
 */
object ChatText {
    /**
     * A tool call as a row: the action and its target, past tense once done ("Ran npm test",
     * "Edited reports/q3.tsx", "Fetched api.example.com"), present while it runs.
     */
    fun phrase(c: ToolCall): String {
        val s = c.summary.trim()
        val target = c.destination?.let(::short) ?: s.substringAfter(' ', s).let(::short)
        fun v(done: String, doing: String, what: String) = (if (c.done) done else doing) + " " + what
        return when (c.tool) {
            "Bash" -> v("Ran", "Running", s)
            "Edit", "MultiEdit", "NotebookEdit" -> v("Edited", "Editing", target)
            "Write" -> v("Wrote", "Writing", target)
            "Read" -> v("Read", "Reading", target)
            "WebFetch" -> v("Fetched", "Fetching", Regex("https?://([^/\\s]+)").find(s)?.groupValues?.get(1) ?: target)
            "WebSearch" -> v("Searched", "Searching", s.removePrefix("search ").trim())
            "Glob", "Grep" -> v("Searched", "Searching", s.substringAfter(' ', s))
            "Task", "Agent" -> if (c.done) "Asked a helper" else "Asking a helper"
            "" -> s.ifEmpty { if (c.done) "Used a tool" else "Using a tool" }
            else -> v("Used", "Using", tool(c.tool))
        }
    }

    /** `mcp__vyre__recall_search` reads "recall search"; a plain name stays. */
    fun tool(name: String): String = name.split("__").last().replace('_', ' ').replace('.', ' ')

    /** A path's last two parts: "/work/harlow/reports/q3.tsx" reads "reports/q3.tsx". */
    fun short(path: String): String {
        val parts = path.trim().trimEnd('/').split('/').filter { it.isNotEmpty() }
        return if (parts.size <= 2) path.trim().trimStart('/') else parts.takeLast(2).joinToString("/")
    }

    /** Tools that read memory or recall: their rows show as a "From memory" block. */
    fun memory(tool: String): Boolean = Regex("(?i)(recall|memory)").containsMatchIn(tool)

    /**
     * Where the transcript puts a centred time stamp: before the first line, and before any line
     * more than an hour after the one before it. `at` per line, null when unknown.
     */
    fun stamps(at: List<Long?>): Set<Int> {
        val out = mutableSetOf<Int>()
        var last: Long? = null
        at.forEachIndexed { i, t ->
            if (t == null) return@forEachIndexed
            if (last == null || t - last!! > 3_600_000L) out += i
            last = t
        }
        return out
    }

    /** "Today 12:01", "Yesterday 09:12", "Sep 25 14:03". */
    fun stamp(at: Long, now: Long = System.currentTimeMillis(), locale: Locale = Locale.getDefault()): String {
        val day = { t: Long -> Calendar.getInstance().apply { timeInMillis = t }.let { it.get(Calendar.YEAR) * 1000 + it.get(Calendar.DAY_OF_YEAR) } }
        val time = SimpleDateFormat("HH:mm", locale).format(Date(at))
        val y = Calendar.getInstance().apply { timeInMillis = now; add(Calendar.DAY_OF_YEAR, -1) }.timeInMillis
        return when (day(at)) {
            day(now) -> "Today $time"
            day(y) -> "Yesterday $time"
            else -> SimpleDateFormat("MMM d", locale).format(Date(at)) + " " + time
        }
    }

    /** Who holds a session's keyboard, as the line above the composer names it. Null when it is this phone or no one. */
    fun holder(h: String?, me: String): String? = when {
        h.isNullOrBlank() || h == me -> null
        h == "deck" -> "The Deck"
        h == "capsule" -> "The Capsule"
        h == "ios" -> "Your iPhone"
        h == "android" -> "Your Android phone"
        h == "terminal" || h == "cli" -> "A terminal"
        h.startsWith("agent:") -> h.removePrefix("agent:")
        h.startsWith("tailnet:") -> "Another of your devices"
        else -> h
    }
}
