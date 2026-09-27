package sh.vyre.app.data

/** One row of Find's Run card: the action in plain words, the command it runs, and what it acts on. */
data class RunRow(val title: String, val command: String, val kind: Kind, val target: String? = null, val text: String = "") {
    enum class Kind { Agent, Drive, Watch, NewSession }
}

/** A thing Find can name: an id and what people call it. */
data class Named(val id: String, val label: String)

/**
 * Find's pure half (phone.md section 7), tested on the JVM: the Run rows for what is typed (the
 * Deck's Find grammar: `@kit ...`, `tell <session> to ...`, `watch <session>`, "New session on
 * ..."), the ranges a match highlights, the snippet's «» marks, and the recent searches.
 */
object FindText {
    /** The Run rows for `q`, at most five, the likeliest first. */
    fun runs(q: String, agents: List<String>, sessions: List<Named>, projects: List<Named>): List<RunRow> {
        val out = mutableListOf<RunRow>()
        when (val r = Router.route(q, agents)) {
            is Route.Agent -> out += if (r.text.isEmpty()) RunRow("Open ${r.agent}", "@${r.agent}", RunRow.Kind.Agent, r.agent)
                else RunRow("Ask ${r.agent}: ${r.text}", "@${r.agent} ${r.text}", RunRow.Kind.Agent, r.agent, r.text)
            is Route.Drive -> Router.candidates(r.target, sessions) { it.label }.take(3).forEach {
                out += RunRow("Tell ${it.label} to ${r.text}", "tell ${it.label} to ${r.text}", RunRow.Kind.Drive, it.id, r.text)
            }
            is Route.Watch -> Router.candidates(r.target, sessions) { it.label }.take(3).forEach {
                out += RunRow("Watch ${it.label}", "watch ${it.label}", RunRow.Kind.Watch, it.id)
            }
            is Route.Assistant -> {
                // Plain words: the agents, sessions and projects they name, as commands to run.
                agents.filter { Router.match(q, it) >= 0.8 }.take(2).forEach { out += RunRow("Ask $it", "@$it ", RunRow.Kind.Agent, it) }
                Router.candidates(q, sessions) { it.label }.take(2).forEach { out += RunRow("Watch ${it.label}", "watch ${it.label}", RunRow.Kind.Watch, it.id) }
                Router.candidates(q, projects) { it.label }.take(2).forEach { out += RunRow("New session on ${it.label}", "new session on ${it.id}", RunRow.Kind.NewSession, it.id) }
            }
            Route.Empty -> {}
        }
        return out.take(5)
    }

    /** Where the typed words appear in `text`, case-folded: each word of two letters or more. */
    fun ranges(text: String, q: String): List<IntRange> {
        val lower = text.lowercase()
        val out = mutableListOf<IntRange>()
        for (w in q.lowercase().split(Regex("[^\\p{L}\\p{N}]+")).filter { it.length >= 2 }.distinct()) {
            var i = lower.indexOf(w)
            while (i >= 0) { out += i until i + w.length; i = lower.indexOf(w, i + w.length) }
        }
        return merge(out)
    }

    /** recall.search brackets its keyword hits with «»: the text without them, and where they were. */
    fun marked(snippet: String): Pair<String, List<IntRange>> {
        val sb = StringBuilder()
        val out = mutableListOf<IntRange>()
        var start = -1
        for (ch in snippet) when (ch) {
            '«' -> start = sb.length
            '»' -> { if (start >= 0 && sb.length > start) out += start until sb.length; start = -1 }
            else -> sb.append(if (ch == '\n') ' ' else ch)
        }
        return sb.toString() to out
    }

    /** The recent searches with `q` first, no repeats, at most `max`. */
    fun recents(prev: List<String>, q: String, max: Int = 8): List<String> {
        val t = q.trim()
        if (t.isEmpty()) return prev.take(max)
        return (listOf(t) + prev.filterNot { it.equals(t, ignoreCase = true) }).take(max)
    }

    /** The typed words as the question the Ask row puts: a capital first, a question mark last. */
    fun question(q: String): String {
        val t = q.trim().trimEnd('?', '.', '!').replaceFirstChar { it.uppercase() }
        return if (t.isEmpty()) "" else "$t?"
    }

    private fun merge(r: List<IntRange>): List<IntRange> {
        val s = r.sortedBy { it.first }
        val out = mutableListOf<IntRange>()
        for (x in s) {
            val last = out.lastOrNull()
            if (last != null && x.first <= last.last + 1) out[out.lastIndex] = last.first..maxOf(last.last, x.last) else out += x
        }
        return out
    }
}
