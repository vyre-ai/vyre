package sh.vyre.app.data

import kotlinx.serialization.json.JsonObject
import sh.vyre.app.api.bool
import sh.vyre.app.api.double
import sh.vyre.app.api.long
import sh.vyre.app.api.str

/** A line of the terminal, mirrored. */
sealed class Line {
    abstract val key: String
    data class User(override val key: String, val text: String, val surface: String?, val at: Long?, val pending: Boolean = false) : Line()
    data class Assistant(override val key: String, val text: String, val done: Boolean) : Line()
    data class Notice(override val key: String, val text: String) : Line()
    data class Tools(override val key: String, val calls: List<ToolCall>) : Line()
    data class Ask(override val key: String, val ask: String, val tool: String, val summary: String, val destination: String?, val reason: String?, val decision: String?) : Line()
    data class Held(override val key: String, val id: String, val state: String) : Line()
    data class Finished(override val key: String, val ok: Boolean, val cost: Double?, val durationMs: Long?, val error: String?) : Line()
    data class Stopped(override val key: String, val reason: String) : Line()
}

data class ToolCall(val id: String, val tool: String, val summary: String, val destination: String?, val done: Boolean, val error: Boolean)

/**
 * Builds the transcript from flattened events, history and live alike (CONTRACT.md 3.3):
 * text deltas accumulate per message id and the final text replaces them; consecutive tool calls
 * fold into one block; asks and held items sit inline; each event is applied once.
 */
class Transcript(val thread: String) {
    private val lines = mutableListOf<Line>()
    private val seen = HashSet<String>()
    var status: String? = null
        private set
    val items: List<Line> get() = lines.toList()

    /** Show what the person typed at once; the box's thread.sent confirms it. */
    fun echo(text: String) { lines += Line.User("local:${lines.size}:${text.hashCode()}", text, "android", System.currentTimeMillis(), pending = true) }

    fun add(e: JsonObject): Boolean {
        val type = e.str("type") ?: return false
        // Only this thread's events; asks and held items without a thread belong to no transcript.
        val t = e.str("thread")
        if (t != null && t != thread) return false
        if (t == null && (type.startsWith("ask.") || type.startsWith("gate.held") || type == "gate.revised")) return false
        val ev = e.str("event")
        if (ev != null && !seen.add(ev)) return false
        when (type) {
            "thread.sent" -> {
                val text = e.str("text").orEmpty()
                val i = lines.indexOfFirst { it is Line.User && it.pending && it.text == text }
                val line = Line.User("sent:$ev", text, e.str("surface"), e.long("at"))
                if (i >= 0) lines[i] = line else lines += line
                status = "working"
            }
            "thread.text" -> {
                val msg = e.str("message") ?: return false
                if (e.bool("notice") == true) { lines += Line.Notice("notice:$ev", e.str("text").orEmpty()); return true }
                val i = lines.indexOfLast { it is Line.Assistant && it.key == "msg:$msg" }
                val done = e.bool("done") == true
                if (i >= 0) {
                    val a = lines[i] as Line.Assistant
                    if (a.done && !done) return false
                    lines[i] = if (done) a.copy(text = e.str("text") ?: a.text, done = true) else a.copy(text = a.text + e.str("delta").orEmpty())
                } else lines += Line.Assistant("msg:$msg", if (done) e.str("text").orEmpty() else e.str("delta").orEmpty(), done)
                status = "working"
            }
            "thread.tool" -> {
                val id = e.str("id") ?: return false
                if (e.str("phase") == "done") {
                    val i = lines.indexOfLast { it is Line.Tools && it.calls.any { c -> c.id == id } }
                    if (i < 0) return false
                    val t = lines[i] as Line.Tools
                    lines[i] = t.copy(calls = t.calls.map { if (it.id == id) it.copy(done = true, error = e.bool("error") == true) else it })
                } else {
                    val call = ToolCall(id, e.str("tool").orEmpty(), e.str("summary").orEmpty(), e.str("destination"), false, false)
                    val last = lines.lastOrNull()
                    if (last is Line.Tools) lines[lines.size - 1] = last.copy(calls = last.calls + call)
                    else lines += Line.Tools("tools:$id", listOf(call))
                }
                status = "working"
            }
            "ask.raised" -> {
                val ask = e.str("ask") ?: return false
                if (lines.any { it is Line.Ask && it.ask == ask }) return false
                lines += Line.Ask("ask:$ask", ask, e.str("tool").orEmpty(), e.str("summary").orEmpty(), e.str("destination"), e.str("reason"), null)
                status = "waiting"
            }
            "ask.answered" -> {
                val ask = e.str("ask") ?: return false
                val i = lines.indexOfFirst { it is Line.Ask && it.ask == ask }
                if (i >= 0) lines[i] = (lines[i] as Line.Ask).copy(decision = e.str("decision") ?: "answered")
                status = "working"
            }
            "gate.held", "gate.revised" -> {
                val id = e.str("id") ?: return false
                if (lines.none { it is Line.Held && it.id == id }) lines += Line.Held("held:$id", id, "held")
            }
            "gate.released", "gate.rejected", "gate.failed" -> {
                val id = e.str("id") ?: return false
                val i = lines.indexOfFirst { it is Line.Held && it.id == id }
                val state = when (type) { "gate.released" -> "sent"; "gate.rejected" -> "discarded"; else -> "held" }
                if (i >= 0) lines[i] = (lines[i] as Line.Held).copy(state = state)
            }
            "thread.finished" -> { lines += Line.Finished("fin:$ev", e.bool("ok") != false, e.double("cost_usd"), e.long("duration_ms"), e.str("error")); status = "idle" }
            "thread.stopped" -> { lines += Line.Stopped("stop:$ev", e.str("reason") ?: "stopped"); status = "stopped" }
            else -> return false
        }
        return true
    }

    /** Asks from threads.get that are still open and not yet on screen. */
    fun openAsk(a: JsonObject) {
        val ask = a.str("id") ?: return
        if (lines.any { it is Line.Ask && it.ask == ask }) return
        lines += Line.Ask("ask:$ask", ask, a.str("tool").orEmpty(), a.str("summary").orEmpty(), a.str("destination"), a.str("reason"), a.str("decision"))
    }

    fun setStatus(s: String?) { status = s }

    /** A recorded turn (recall.thread), for a session that ran in a terminal and is not a live thread. */
    fun turn(seq: Long?, role: String?, text: String, ts: Long?) {
        val key = "turn:${seq ?: lines.size}"
        if (lines.any { it.key == key } || text.isBlank()) return
        lines += if (role == "user") Line.User(key, text, "terminal", ts) else Line.Assistant(key, text, done = true)
    }
}
