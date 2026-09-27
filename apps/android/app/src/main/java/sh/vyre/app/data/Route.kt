package sh.vyre.app.data

import java.text.Normalizer

/** What the Capsule's words mean, before Enter (the phone's half of local/capsule/lib/route.js). */
sealed class Route {
    /** `@juno what came in overnight`: agents.ask to that agent. */
    data class Agent(val agent: String, val text: String) : Route()
    /** `tell the intake thread to run the tests`: threads.send, then threads.watch. */
    data class Drive(val target: String, val text: String) : Route()
    /** `watch the intake thread`, `tell me when harlow is done`. */
    data class Watch(val target: String) : Route()
    /** Everything else asks the assistant. */
    data class Assistant(val text: String) : Route()
    object Empty : Route()
}

object Router {
    private val DRIVE = Regex("^(?:tell|ask)\\s+(?:the\\s+)?(.+?)(?:\\s+thread)?\\s+to\\s+(.+)$", RegexOption.IGNORE_CASE)
    private val WATCH1 = Regex("^(?:watch|monitor|track)\\s+(?:the\\s+)?(.+?)(?:\\s+thread)?(?:\\s+and\\s+tell\\s+me.*)?$", RegexOption.IGNORE_CASE)
    private val WATCH2 = Regex("^(?:tell|ping|notify)\\s+me\\s+when\\s+(?:the\\s+)?(.+?)(?:\\s+thread)?\\s+(?:is\\s+)?(?:done|finishes|finished|asks)\\s*\\.?$", RegexOption.IGNORE_CASE)
    private val AT = Regex("^@([A-Za-z0-9_.-]+)\\s*(.*)$", RegexOption.DOT_MATCHES_ALL)

    fun route(raw: String, agents: Collection<String>): Route {
        val q = raw.trim()
        if (q.isEmpty()) return Route.Empty
        AT.find(q)?.let { m -> agents.firstOrNull { it.equals(m.groupValues[1], true) }?.let { return Route.Agent(it, m.groupValues[2].trim()) } }
        WATCH2.find(q)?.let { return Route.Watch(it.groupValues[1].trim()) }
        DRIVE.find(q)?.let { return Route.Drive(it.groupValues[1].trim(), it.groupValues[2].trim()) }
        WATCH1.find(q)?.let { return Route.Watch(it.groupValues[1].trim()) }
        return Route.Assistant(q)
    }

    /** The partial `@ju` being typed, for autocomplete, or null. */
    fun mentionPrefix(raw: String): String? = Regex("^@([A-Za-z0-9_.-]*)$").find(raw.trim())?.groupValues?.get(1)

    private fun fold(s: String) = Normalizer.normalize(s, Normalizer.Form.NFD).replace(Regex("[\\u0300-\\u036f]"), "").lowercase()
    private fun compact(s: String) = s.replace(Regex("[^a-z0-9]+"), "")
    private fun wordsOf(label: String) = Normalizer.normalize(label, Normalizer.Form.NFD).replace(Regex("[\\u0300-\\u036f]"), "")
        .replace(Regex("([a-z0-9])([A-Z])"), "$1 $2").replace(Regex("([A-Z])([A-Z][a-z])"), "$1 $2")
        .lowercase().split(Regex("[^a-z0-9]+")).filter { it.isNotEmpty() }

    private fun subsequence(q: String, s: String): Boolean { var i = 0; for (c in s) { if (i < q.length && c == q[i]) i++ }; return i == q.length }

    /** local/capsule/lib/local.js match(): exact 1, prefix 0.9, word prefix or initials 0.8, substring 0.5, in-order letters 0.3. */
    fun match(query: String, label: String): Double {
        val q = fold(query).trim()
        if (q.isEmpty()) return 0.0
        val l = fold(label)
        if (l.isEmpty()) return 0.0
        val qc = compact(q); val lc = compact(l)
        if (l == q || (qc.isNotEmpty() && lc == qc)) return 1.0
        if (l.startsWith(q) || (qc.isNotEmpty() && lc.startsWith(qc))) return 0.9
        val ws = wordsOf(label)
        if (ws.any { it.startsWith(qc.ifEmpty { q }) }) return 0.8
        if (qc.length >= 2 && ws.size >= 2 && ws.joinToString("") { it.take(1) }.startsWith(qc)) return 0.8
        if (l.contains(q) || (qc.length >= 2 && lc.contains(qc))) return 0.5
        if (qc.length >= 2 && subsequence(qc, lc)) return 0.3
        return 0.0
    }

    /** The sessions a target could mean, best first, as the Capsule offers them (score at least 0.5). */
    fun <T> candidates(target: String, items: List<T>, label: (T) -> String): List<T> =
        items.map { it to match(target, label(it)) }.filter { it.second >= 0.5 }.sortedByDescending { it.second }.map { it.first }
}
