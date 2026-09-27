package sh.vyre.app.data

import kotlinx.serialization.json.JsonObject
import sh.vyre.app.api.bool
import sh.vyre.app.api.double
import sh.vyre.app.api.long
import sh.vyre.app.api.str

/**
 * Who a line is by, as the transcript labels it (Speaker's rule): the user's messages "you", an
 * agent's by its name, replies by the thread's agent or the assistant. Null for lines with no speaker.
 */
fun speakerOf(l: Line, threadAgent: String?, assistant: String): String? = when (l) {
    is Line.User -> Speaker.sender(l.surface, assistant)
    is Line.Assistant -> Speaker.reply(threadAgent, assistant)
    else -> null
}

/** A line of the terminal, mirrored. */
sealed class Line {
    abstract val key: String
    data class User(override val key: String, val text: String, val surface: String?, val at: Long?, val pending: Boolean = false) : Line()
    data class Assistant(override val key: String, val text: String, val done: Boolean) : Line()
    data class Notice(override val key: String, val text: String) : Line()
    data class Tools(override val key: String, val calls: List<ToolCall>) : Line()
    data class Ask(override val key: String, val ask: String, val tool: String, val summary: String, val destination: String?, val reason: String?, val decision: String?,
                   val scope: String? = null, val decidedAt: Long? = null, val raw: JsonObject? = null) : Line() {
        /** A question (AskUserQuestion) rather than a permission. */
        val question: Boolean get() = raw?.str("kind") == "question"
    }
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
    /** Per line: the events that made it and when it began, so Open session can find it (Anchor). */
    private val events = HashMap<String, MutableSet<Long>>()
    private val began = HashMap<String, Long>()
    private var oldest: Long? = null
    private var earliest: Long? = null
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
        val before = lines.size
        val ok = apply(type, e, ev)
        if (ok) note(e, ev, before)
        return ok
    }

    /** Record which line an event made or changed (the last new one, or the one whose content moved). */
    private fun note(e: JsonObject, ev: String?, before: Int) {
        val key = (if (lines.size > before) lines.last().key else touched) ?: return
        touched = null
        val id = ev?.toLongOrNull()
        if (id != null) { events.getOrPut(key) { HashSet() } += id; if (oldest == null || id < oldest!!) oldest = id }
        e.long("at")?.let { at -> if (key !in began) began[key] = at; if (earliest == null || at < earliest!!) earliest = at }
    }
    private var touched: String? = null

    /**
     * The line an anchor points at (phone.md section 15): the tool row holding `tool_use_id`, else
     * the line its event made, else the first line after that event, else the first line at or
     * after `at`. Null when it is not in what is loaded; [older] says whether paging back may find it.
     */
    fun locate(a: Anchor): Int? {
        a.toolUseId?.let { id -> lines.indexOfFirst { it is Line.Tools && it.calls.any { c -> c.id == id } }.takeIf { it >= 0 }?.let { return it } }
        a.event?.let { ev ->
            lines.indexOfFirst { events[it.key]?.contains(ev) == true }.takeIf { it >= 0 }?.let { return it }
            if (oldest != null && ev >= oldest!!) lines.indexOfFirst { l -> (events[l.key]?.minOrNull() ?: -1L) >= ev }.takeIf { it >= 0 }?.let { return it }
        }
        a.at?.let { at -> if (earliest != null && at >= earliest!!) lines.indexOfFirst { (began[it.key] ?: -1L) >= at }.takeIf { it >= 0 }?.let { return it } }
        return null
    }

    /** When a line began, for the time stamps at the gaps. */
    fun at(key: String): Long? = began[key]

    /** Whether the anchor lies before everything loaded, so an older page may hold it. */
    fun older(a: Anchor): Boolean = (a.event != null && oldest != null && a.event < oldest!!) || (a.at != null && earliest != null && a.at < earliest!!)

    private fun apply(type: String, e: JsonObject, ev: String?): Boolean {
        when (type) {
            "thread.sent" -> {
                val text = e.str("text").orEmpty()
                val i = lines.indexOfFirst { it is Line.User && it.pending && it.text == text }
                val line = Line.User("sent:$ev", text, e.str("surface"), e.long("at"))
                if (i >= 0) { lines[i] = line; touched = line.key } else lines += line
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
                    touched = a.key
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
                    touched = t.key
                    lines[i] = t.copy(calls = t.calls.map { if (it.id == id) it.copy(done = true, error = e.bool("error") == true) else it })
                } else {
                    val call = ToolCall(id, e.str("tool").orEmpty(), e.str("summary").orEmpty(), e.str("destination"), false, false)
                    val last = lines.lastOrNull()
                    if (last is Line.Tools) { lines[lines.size - 1] = last.copy(calls = last.calls + call); touched = last.key }
                    else lines += Line.Tools("tools:$id", listOf(call))
                }
                status = "working"
            }
            "ask.raised" -> {
                val ask = e.str("ask") ?: return false
                if (lines.any { it is Line.Ask && it.ask == ask }) return false
                lines += Line.Ask("ask:$ask", ask, e.str("tool").orEmpty(), e.str("summary").orEmpty(), e.str("destination"), e.str("reason"), null, raw = e)
                status = "waiting"
            }
            "ask.answered" -> {
                val ask = e.str("ask") ?: return false
                val i = lines.indexOfFirst { it is Line.Ask && it.ask == ask }
                if (i >= 0) { lines[i] = (lines[i] as Line.Ask).copy(decision = e.str("decision") ?: "answered", scope = e.str("scope"), decidedAt = e.long("at")); touched = lines[i].key }
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
        lines += Line.Ask("ask:$ask", ask, a.str("tool").orEmpty(), a.str("summary").orEmpty(), a.str("destination"), a.str("reason"), a.str("decision"), raw = a)
        a.long("at")?.let { began["ask:$ask"] = it }
    }

    fun setStatus(s: String?) { status = s }

    /** A recorded turn (recall.thread), for a session that ran in a terminal and is not a live thread. */
    fun turn(seq: Long?, role: String?, text: String, ts: Long?) {
        val key = "turn:${seq ?: lines.size}"
        if (lines.any { it.key == key } || text.isBlank()) return
        lines += if (role == "user") Line.User(key, text, "terminal", ts) else Line.Assistant(key, text, done = true)
    }
}
