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
import kotlinx.coroutines.delay
import kotlinx.coroutines.coroutineScope
import androidx.compose.runtime.LaunchedEffect
import sh.vyre.app.api.at
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
 * Find (the PWA's phone Capsule, views/find.js): one search box. Plain words ask the assistant,
 * `@juno ...` asks that agent, `tell the intake thread to ...` types into a session and watches
 * it, `watch harlow` watches one; what Enter will do is written under the box first. As you type,
 * results come in the PWA's order: sessions (recall.search and the live threads), files
 * (files.search, the box's only), agents, memory (memory.relevant), projects. Vault and Memory
 * are links, never results. Voice is not in this build (see the note under the box).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun FindScreen() {
    val app = LocalApp.current
    val nav = LocalNav.current
    val scope = rememberCoroutineScope()
    var q by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }
    val focus = remember { FocusRequester() }
    val agents = rememberLoad("find-agents") { app.client.call("agents.list").arr.toList() }
    val threads = rememberLoad("find-threads") { app.client.call("threads.list").arr.toList() }
    val projects = rememberLoad("find-projects") { app.client.call("projects.list").at("projects").arr.toList() }
    OnEvents("thread.started", "thread.stopped") { threads.refresh() }
    var found by remember { mutableStateOf(Found("", null, null, null)) }

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

    // Searches as the person pauses typing (300 ms, 2 characters at least), for questions and
    // @agent text alike; tell and watch only match sessions by name.
    val searchText = when (val r = route) { is Route.Assistant -> r.text; is Route.Agent -> r.text; else -> "" }.trim()
    LaunchedEffect(searchText) {
        if (searchText.length < 2) { found = Found("", null, null, null); return@LaunchedEffect }
        delay(300)
        found = Found(searchText, null, null, null)
        coroutineScope {
            launch { val r = runCatching { app.client.call("recall.search", input("q" to searchText, "limit" to 20, "per_session" to 1)).arr.toList() }; found = found.copy(recall = r) }
            launch { val r = runCatching { app.client.call("files.search", input("q" to searchText, "limit" to 20)).at("results").arr.toList() }; found = found.copy(files = r) }
            launch {
                // memory.relevant over the tailnet needs a room for the main graph (CONTRACT.md 4.2); memory.facts about the words is the fallback.
                val r = runCatching { app.client.call("memory.relevant", input("text" to searchText, "limit" to 5)).arr.toList() }
                    .recoverCatching { app.client.call("memory.facts", input("about" to searchText, "limit" to 5)).at("facts").arr.toList() }
                found = found.copy(memory = r)
            }
        }
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
        Text("Find", style = Type.h1, color = V.c.text, modifier = Modifier.padding(top = Space.s, bottom = Space.m))
        InputBox(q, { q = it; note = null }, "Find or ask, @agent, tell or watch", imeAction = ImeAction.Go, onGo = { go() }, focusRequester = focus,
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

        if (searchText.isNotEmpty()) results(searchText, found, sessions, agentList, projects.v.value.orEmpty(), nav)

        if (route == Route.Empty) {
            item { SectionHead("Places") }
            item { Row2("Vault", "Names on the box; a value only after your fingerprint", onClick = { nav("vault") }) }
            item { Row2("Memory", "What Vyre has learned, and where from", onClick = { nav("memory") }) }
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

/** What the searches returned for `q`: null while one is still out, a failure when it was refused. */
data class Found(val q: String, val recall: Result<List<JsonElement>>?, val files: Result<List<JsonElement>>?, val memory: Result<List<JsonElement>>?)

/** The results, in the PWA's order: sessions, files, agents, memory, projects. */
private fun androidx.compose.foundation.lazy.LazyListScope.results(q: String, f: Found, live: List<JsonElement>, agents: List<JsonElement>, projects: List<JsonElement>, nav: (String) -> Unit) {
    val byName = live.filter { Router.match(q, label(it)) >= 0.5 }
    val hits = f.recall?.getOrNull().orEmpty().filter { h -> byName.none { it.str("id") == h.str("session") } }
    item { SectionHead("Sessions · ${byName.size + hits.size}") }
    items(byName, key = { "ls" + it.str("id") }) { t -> Row2(label(t), dots(t.str("agent"), t.str("status")), onClick = { nav("thread/${t.str("id")}") }) }
    items(hits, key = { "rs" + it.str("session") + ":" + it.str("seq") }) { h ->
        Row2(h.str("title") ?: h.str("name") ?: h.str("session").orEmpty().take(8),
            dots((h.str("snippet") ?: h.str("text"))?.replace("\u00ab", "")?.replace("\u00bb", "")?.replace('\n', ' ')?.take(120), h.str("ts")?.toLongOrNull()?.let { ago(it) }),
            onClick = { h.str("session")?.let { nav("thread/$it") } })
    }
    searching(f.recall, "Sessions were not searched.", byName.isEmpty())

    val files = f.files?.getOrNull().orEmpty()
    item { SectionHead("Files · ${files.size}", "box") }
    items(files, key = { "f" + it.str("path") }) { x ->
        Row2(x.str("name") ?: x.str("path").orEmpty(), dots(x.str("kind"), x.str("path")), onClick = { x.str("path")?.let { nav("file/" + android.net.Uri.encode(it)) } })
    }
    searching(f.files, "Files were not searched.", true, "Files on the Mac cannot be reached from a phone yet.")

    val ag = agents.filter { Router.match(q, it.str("name").orEmpty()) >= 0.5 }
    if (ag.isNotEmpty()) {
        item { SectionHead("Agents · ${ag.size}") }
        items(ag, key = { "ag" + it.str("name") }) { a -> Row2("@" + a.str("name").orEmpty(), dots(a.str("kind"), a.str("doing")), onClick = { nav("agent/" + android.net.Uri.encode(a.str("name").orEmpty())) }) }
    }

    val mem = f.memory?.getOrNull().orEmpty().filter { !it.str("text").isNullOrBlank() }
    item { SectionHead("From memory · ${mem.size}", color = V.c.recall) }
    items(mem, key = { "m" + (it.str("id") ?: it.str("text")) }) { m ->
        Row2(m.str("text").orEmpty(), dots(m.str("age"), m.str("source")), subColor = null,
            leading = { sh.vyre.app.design.Dot(V.c.recall) },
            onClick = { nav(m.str("id")?.let { "fact/" + android.net.Uri.encode(it) } ?: ("memory/" + android.net.Uri.encode(q))) })
    }
    searching(f.memory, "Memory was not searched.", true)

    val pr = projects.filter { Router.match(q, it.str("name") ?: it.str("slug").orEmpty()) >= 0.5 }
    if (pr.isNotEmpty()) {
        item { SectionHead("Projects · ${pr.size}") }
        items(pr, key = { "p" + it.str("slug") }) { p -> Row2(p.str("name") ?: p.str("slug").orEmpty(), p.str("org"), onClick = { nav("project/${p.str("slug")}") }) }
    }
}

/** Under a section: "Looking" while it is out, why it failed, or nothing found. */
private fun androidx.compose.foundation.lazy.LazyListScope.searching(r: Result<List<JsonElement>>?, failed: String, emptyToo: Boolean, empty: String = "Nothing found.") {
    when {
        r == null -> item { Quiet("Looking") }
        r.isFailure -> item { Quiet(failed + " " + (r.exceptionOrNull()?.plain() ?: "")) }
        r.getOrNull().isNullOrEmpty() && emptyToo -> item { Quiet(empty) }
    }
}

/** A session's name as people say it. */
fun label(t: JsonElement): String = t.str("name")?.takeIf { it.isNotBlank() } ?: t.str("id").orEmpty().take(8)

/** loadState for a list inside a LazyListScope, under a heading. */
fun androidx.compose.foundation.lazy.LazyListScope.loadStateItems(l: Load<*>, empty: Boolean, emptyText: String) = loadState(l, empty, emptyText)
