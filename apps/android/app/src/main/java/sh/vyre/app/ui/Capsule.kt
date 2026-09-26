package sh.vyre.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import sh.vyre.app.api.arr
import sh.vyre.app.api.input
import sh.vyre.app.api.plain
import sh.vyre.app.api.str
import sh.vyre.app.data.Route
import sh.vyre.app.data.Router
import sh.vyre.app.data.ago
import sh.vyre.app.design.Chip
import sh.vyre.app.design.Label
import sh.vyre.app.design.SectionHead
import sh.vyre.app.design.Space
import sh.vyre.app.design.Type
import sh.vyre.app.design.V

/** The phone's surface name on every write (ADR 0018): leases, sends, answers, watches. */
const val SURFACE = "android"

/**
 * The Capsule on the phone: one search box. Plain words ask the assistant, `@juno ...` asks that
 * agent, `tell the intake thread to ...` types into a session and watches it, `watch harlow`
 * watches one. What Enter will do is written under the box before it happens. Voice is not in
 * this build (see the note under the box).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun CapsuleScreen() {
    val app = LocalApp.current
    val nav = LocalNav.current
    val scope = rememberCoroutineScope()
    var q by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }
    val focus = remember { FocusRequester() }
    val agents = rememberLoad("capsule-agents") { app.client.call("agents.list").arr.toList() }
    val threads = rememberLoad("capsule-threads") { app.client.call("threads.list").arr.toList() }
    OnEvents("thread.started", "thread.stopped") { threads.refresh() }

    val agentList = agents.v.value.orEmpty()
    val names = agentList.mapNotNull { it.str("name") }
    val assistant = agentList.firstOrNull { it.str("kind") == "assistant" }?.str("name")
    val sessions = threads.v.value.orEmpty()
    val route = Router.route(q, names)
    val mention = Router.mentionPrefix(q)
    val targets: List<JsonElement> = when (route) {
        is Route.Drive -> Router.candidates(route.target, sessions) { label(it) }
        is Route.Watch -> Router.candidates(route.target, sessions) { label(it) }
        else -> emptyList()
    }

    fun ask(agent: String, text: String) {
        busy = true; note = null
        scope.launch {
            try {
                val out = app.client.call("agents.ask", input("agent" to agent, "text" to text, "surface" to SURFACE, "wait" to false), timeoutSec = 60)
                val thread = out.str("thread")
                if (out.str("ok") == "false") note = out.str("note") ?: "$agent did not take it."
                else if (thread != null) { q = ""; nav("thread/$thread") }
                else note = "Sent to $agent."
            } catch (e: Exception) { note = e.plain() }
            busy = false
        }
    }

    fun watch(t: JsonElement, what: String) {
        val id = t.str("id") ?: return
        scope.launch {
            try {
                app.client.call("threads.watch", input("thread" to id, "until" to "either", "notify" to SURFACE, "note" to what))
                note = "Watching ${label(t)}. You will hear when it finishes or asks."
                q = ""
            } catch (e: Exception) { note = e.plain() }
        }
    }

    fun drive(t: JsonElement, text: String) {
        val id = t.str("id") ?: return
        busy = true; note = null
        scope.launch {
            try {
                val out = app.client.call("threads.send", input("thread" to id, "text" to text, "surface" to SURFACE))
                if (out.str("sent") == "true") {
                    runCatching { app.client.call("threads.watch", input("thread" to id, "until" to "either", "notify" to SURFACE, "note" to "Tell ${label(t)}: $text")) }
                    note = "Sent to ${label(t)}. You will hear when it finishes or asks."
                    q = ""
                } else note = out.str("note") ?: "${out.str("holder") ?: "Someone"} has the keyboard."
            } catch (e: Exception) { note = e.plain() }
            busy = false
        }
    }

    fun go() {
        if (busy) return
        when (val r = route) {
            is Route.Agent -> if (r.text.isEmpty()) nav("agent/" + android.net.Uri.encode(r.agent)) else ask(r.agent, r.text)
            is Route.Assistant -> if (assistant == null) note = "This box has no assistant yet. Try @ and an agent's name." else ask(assistant, r.text)
            is Route.Drive -> targets.firstOrNull()?.let { drive(it, r.text) } ?: run { note = "No session matches \"${r.target}\"." }
            is Route.Watch -> targets.firstOrNull()?.let { watch(it, "Watch ${label(it)}") } ?: run { note = "No session matches \"${r.target}\"." }
            Route.Empty -> {}
        }
    }

    val hint = when (val r = route) {
        is Route.Agent -> if (r.text.isEmpty()) "Enter opens @${r.agent}." else "Enter asks @${r.agent}."
        is Route.Assistant -> if (assistant != null) "Enter asks $assistant, the assistant." else "No assistant on this box."
        is Route.Drive -> targets.firstOrNull()?.let { "Enter types into ${label(it)}, then watches it." } ?: "No session matches \"${r.target}\" yet."
        is Route.Watch -> targets.firstOrNull()?.let { "Enter watches ${label(it)}." } ?: "No session matches \"${r.target}\" yet."
        Route.Empty -> null
    }

    Page(top = {
        BrandBar()
        Text("Ask, tell or watch.", style = Type.h2, color = V.c.text, modifier = Modifier.padding(top = Space.s, bottom = Space.m))
        InputBox(q, { q = it; note = null }, "Ask anything, @agent, tell or watch a session", imeAction = ImeAction.Go, onGo = { go() }, focusRequester = focus,
            trailing = {
                // Voice needs on-device recognition (ADR 0018 section 8); this build has none yet.
                androidx.compose.foundation.layout.Box(
                    Modifier.size(44.dp).semantics { contentDescription = "Voice, not available in this build"; disabled() },
                    contentAlignment = androidx.compose.ui.Alignment.Center,
                ) { Label("Mic", color = V.c.rule) }
            })
        Label(hint ?: "Voice is not in this build yet. Type instead.", Modifier.padding(top = Space.s), color = if (hint != null) V.c.secondary else V.c.label)
    }) {
        note?.let { n -> item { Quiet(n) } }
        if (busy) item { Quiet("Sending") }

        // @ju: the agents whose names start so.
        if (mention != null) {
            val found = agentList.filter { it.str("name").orEmpty().startsWith(mention, ignoreCase = true) }
            item { SectionHead("Agents · ${found.size}") }
            items(found, key = { "m" + it.str("name") }) { a ->
                Row2("@" + a.str("name").orEmpty(), dots(a.str("kind"), a.str("doing")), onClick = { q = "@" + a.str("name") + " "; focus.requestFocus() })
            }
        }

        // tell / watch: which session it means, best first; tap one to choose it.
        if (route is Route.Drive || route is Route.Watch) {
            item { SectionHead("Sessions · ${targets.size}") }
            if (targets.isEmpty()) item { Quiet("Sessions running now or in the last day are matched by name.") }
            items(targets, key = { "t" + it.str("id") }) { t ->
                Row2(label(t), dots(t.str("agent"), t.str("project"), t.str("status")), onClick = {
                    when (val r = route) { is Route.Drive -> drive(t, r.text); is Route.Watch -> watch(t, "Watch ${label(t)}"); else -> {} }
                })
            }
        }

        if (route == Route.Empty) {
            item { SectionHead("Try") }
            item {
                val tries = buildList {
                    add("What came in overnight?")
                    names.firstOrNull { it != assistant }?.let { add("@$it ") }
                    sessions.firstOrNull()?.let { add("watch ${label(it)}") }
                    sessions.firstOrNull()?.let { add("tell ${label(it)} to ") }
                }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(Space.s), verticalArrangement = Arrangement.spacedBy(Space.s)) {
                    for (t in tries) Chip(t, onClick = { q = t; focus.requestFocus() })
                }
            }
            item { SectionHead("Sessions · ${sessions.size}", if (sessions.isNotEmpty()) "Tap to open" else null) }
            loadStateItems(threads.v, sessions.isEmpty(), "No session ran in the last day.")
            items(sessions.take(12), key = { "s" + it.str("id") }) { t ->
                Row2(label(t), dots(t.str("agent"), t.str("status"), ago(t.str("last")?.toLongOrNull())), onClick = { nav("thread/${t.str("id")}") })
            }
        }
    }
}

/** A session's name as people say it. */
fun label(t: JsonElement): String = t.str("name")?.takeIf { it.isNotBlank() } ?: t.str("id").orEmpty().take(8)

/** loadState for a list inside a LazyListScope, under a heading. */
fun androidx.compose.foundation.lazy.LazyListScope.loadStateItems(l: Load<*>, empty: Boolean, emptyText: String) = loadState(l, empty, emptyText)
