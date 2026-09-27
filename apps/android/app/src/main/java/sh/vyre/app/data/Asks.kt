package sh.vyre.app.data

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import sh.vyre.app.api.arr
import sh.vyre.app.api.at
import sh.vyre.app.api.bool
import sh.vyre.app.api.long
import sh.vyre.app.api.str

/**
 * Whether an item's action shows the fingerprint glyph (the user's no-nag rule): only when the box
 * says a proof is required and no live presence session on this phone covers it. With no
 * `presence` field the app never guesses from the tool name: no glyph, and the call goes plainly.
 */
object Gate {
    fun glyph(item: JsonElement?): Boolean {
        val p = item.at("presence") ?: return false
        return p.bool("required") == true && p.bool("covered") != true
    }

    /** `presence.required` when the box says, else null (Client.callOrProve then asks the box). */
    fun required(item: JsonElement?): Boolean? = item.at("presence")?.bool("required")
}

// ---- Questions (threads.asks kind "question": Claude Code's AskUserQuestion) ----

data class Choice(val label: String, val description: String?)
data class Question(val question: String, val header: String?, val multi: Boolean, val options: List<Choice>)

/** What the sheet holds for one question: the labels chosen, and the typed "Something else". */
data class Pick(val chosen: List<String> = emptyList(), val other: Boolean = false, val text: String = "")

/**
 * A question's answer, as deck/chat/lib/answers.js builds it (the same rules, so the Deck and
 * the phone send the same words): single-select is the label or the typed text; multi-select
 * is the labels in the options' order joined with ", ", the typed text last. Pure, tested.
 */
object Questions {
    fun of(ask: JsonElement?): List<Question> = ask.at("questions").arr.mapNotNull { q ->
        val text = q.str("question")?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
        Question(text, q.str("header")?.takeIf { it.isNotBlank() }, q.bool("multiSelect") == true,
            q.at("options").arr.mapNotNull { o -> o.str("label")?.let { Choice(it, o.str("description")?.takeIf { d -> d.isNotBlank() }) } })
    }

    /** Tap a choice, or the "Something else" row when `label` is null. Single-select replaces, multi-select toggles. */
    fun choose(q: Question, p: Pick, label: String?): Pick = when {
        q.multi && label == null -> p.copy(other = !p.other)
        q.multi -> p.copy(chosen = if (label in p.chosen) p.chosen - label!! else p.chosen + label!!)
        label == null -> p.copy(chosen = emptyList(), other = true)
        else -> p.copy(chosen = listOf(label), other = false)
    }

    fun text(q: Question, p: Pick): String {
        val typed = if (p.other) p.text.trim() else ""
        if (q.multi) return (q.options.map { it.label }.filter { it in p.chosen } + listOfNotNull(typed.ifEmpty { null })).joinToString(", ")
        return if (p.other) typed else p.chosen.firstOrNull().orEmpty()
    }

    fun answered(q: Question, p: Pick) = text(q, p).isNotEmpty()

    /** threads.answer's `answers`: {[question]: answer}, or null while one is still unanswered. */
    fun answers(qs: List<Question>, picks: List<Pick>): Map<String, String>? {
        if (qs.isEmpty()) return null
        val out = LinkedHashMap<String, String>()
        qs.forEachIndexed { i, q -> val a = text(q, picks.getOrElse(i) { Pick() }); if (a.isEmpty()) return null; out[q.question] = a }
        return out
    }
}

// ---- What an ask's sheet shows (phone.md section 5, Ask) ----

data class Fact(val label: String, val value: String)
data class FileChange(val file: String, val added: Long, val removed: Long)
data class Changes(val files: Int, val added: Long, val removed: Long, val list: List<FileChange>) {
    /** "6 files +412 -38". */
    val line: String get() = "$files file${if (files == 1) "" else "s"} +$added -$removed"
}

object AskView {
    /** The command in the mono block: the Bash command, else the summary. */
    fun command(ask: JsonElement?): String = ask.at("detail").str("command") ?: ask.str("summary").orEmpty()

    /** Why the agent wants to: the ask's reason, else what the tool call said it was for. */
    fun why(ask: JsonElement?): String? = (ask.str("reason") ?: ask.at("detail").str("description"))?.takeIf { it.isNotBlank() }

    /** Fact rows: Remote and Branch for a push, the file or URL, and the rule that held it when the box says. */
    fun facts(ask: JsonElement?): List<Fact> {
        val out = mutableListOf<Fact>()
        val d = ask.at("detail")
        if (ask.str("tool") == "Bash") push(command(ask))?.let { (remote, branch) -> out += Fact("Remote", remote); branch?.let { out += Fact("Branch", it) } }
        (d.str("file") ?: ask.str("destination")?.takeIf { ask.str("tool") != "Bash" && ask.str("tool") != "WebFetch" })?.let { out += Fact("File", it) }
        (d.str("url") ?: ask.str("destination")?.takeIf { ask.str("tool") == "WebFetch" })?.let { out += Fact("URL", it) }
        (ask.str("held_by") ?: ask.str("rule"))?.let { out += Fact("Held by", it) }
        return out
    }

    /** `git push [flags] <remote> [<src>:]<branch>`: the remote and the branch, or null for anything else. */
    fun push(cmd: String): Pair<String, String?>? {
        val w = cmd.trim().split(Regex("\\s+"))
        if (w.size < 2 || w[0] != "git" || w[1] != "push") return null
        val args = w.drop(2).filterNot { it.startsWith("-") }
        val remote = args.getOrNull(0) ?: return "origin" to null
        return remote to args.getOrNull(1)?.substringAfter(':')
    }

    /**
     * The Changes row (phone.md section 15): `totals` when the box gives them, else the sum of
     * `changes`, read from the ask's detail or the item itself. Null when there are neither.
     */
    fun changes(item: JsonElement?): Changes? {
        val list = (item.at("detail").at("changes") ?: item.at("changes")).arr.mapNotNull { c ->
            c.str("file")?.let { FileChange(it, c.long("added") ?: 0L, c.long("removed") ?: 0L) }
        }
        val t = item.at("totals") ?: item.at("detail").at("totals")
        if (t != null) return Changes((t.long("files") ?: list.size.toLong()).toInt(), t.long("added") ?: 0L, t.long("removed") ?: 0L, list)
        if (list.isEmpty()) return null
        return Changes(list.size, list.sumOf { it.added }, list.sumOf { it.removed }, list)
    }

    /** An Edit's change as diff lines: the old text removed, the new text added. Empty when the ask carries neither. */
    fun diff(ask: JsonElement?): List<Pair<Char, String>> {
        val d = ask.at("detail")
        val old = d.str("old"); val new = d.str("new") ?: d.str("content")
        if (old == null && new == null) return emptyList()
        return (old?.lines()?.map { '-' to it } ?: emptyList()) + (new?.lines()?.map { '+' to it } ?: emptyList())
    }
}

// ---- Open session (phone.md section 15: anchors) ----

/**
 * Where an item sits in its session: the tool call (`tool_use_id`), else the event (`ask.raised`
 * or `gate.held`), else the first transcript item at or after `at`. It rides the route
 * `thread/<id>?tu=..&ev=..&at=..` into Chat.
 */
data class Anchor(val toolUseId: String? = null, val event: Long? = null, val at: Long? = null) {
    val empty: Boolean get() = toolUseId == null && event == null && at == null

    companion object {
        private val SAFE = Regex("^[A-Za-z0-9_.-]{1,128}$")

        /** From an ask (`anchor: {tool_use_id, event}`, its own `at`) or a gate item (`anchor: {tool_use_id, event, thread, at}`). */
        fun of(item: JsonElement?): Anchor {
            val a = item.at("anchor")
            return Anchor(a.str("tool_use_id")?.takeIf { SAFE.matches(it) }, a.long("event"), a.long("at") ?: item.long("at"))
        }

        /** The route into the session with its anchor, or null when the thread id is not one. */
        fun route(thread: String?, a: Anchor): String? {
            val base = Links.session(thread) ?: return null
            val q = listOfNotNull(a.toolUseId?.let { "tu=$it" }, a.event?.let { "ev=$it" }, a.at?.let { "at=$it" })
            return if (q.isEmpty()) base else base + "?" + q.joinToString("&")
        }

        /** The thread id and anchor of a `thread/<id>?..` route's rest. */
        fun parse(rest: String): Pair<String, Anchor> {
            val id = rest.substringBefore('?')
            val q = rest.substringAfter('?', "").split('&').mapNotNull { kv -> kv.split('=', limit = 2).takeIf { it.size == 2 }?.let { it[0] to it[1] } }.toMap()
            return id to Anchor(q["tu"]?.takeIf { SAFE.matches(it) }, q["ev"]?.toLongOrNull(), q["at"]?.toLongOrNull())
        }
    }
}

/** The input for threads.answer: the ask, the decision, the surface, and answers or scope when given. */
fun answerInput(ask: String, decision: String, surface: String, answers: Map<String, String>? = null, scope: String? = null): JsonObject =
    JsonObject(buildMap {
        put("ask", JsonPrimitive(ask)); put("decision", JsonPrimitive(decision)); put("surface", JsonPrimitive(surface))
        if (answers != null) put("answers", JsonObject(answers.mapValues { JsonPrimitive(it.value) }))
        if (scope != null) put("scope", JsonPrimitive(scope))
    })

/** "Held just now", "Held 4 min", "Held 2 h", "Held 3 d": the sheet's third row. */
fun heldFor(at: Long?, now: Long = System.currentTimeMillis()): String {
    if (at == null || at <= 0) return "Held"
    val s = ((now - at) / 1000).coerceAtLeast(0)
    return when { s < 60 -> "Held just now"; s < 3600 -> "Held ${s / 60} min"; s < 86400 -> "Held ${s / 3600} h"; else -> "Held ${s / 86400} d" }
}
