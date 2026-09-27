package sh.vyre.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import sh.vyre.app.api.arr
import sh.vyre.app.api.at
import sh.vyre.app.api.input
import sh.vyre.app.api.plain
import sh.vyre.app.api.str
import sh.vyre.app.data.FindText
import sh.vyre.app.data.Named
import sh.vyre.app.data.Route
import sh.vyre.app.data.Router
import sh.vyre.app.data.RunRow
import sh.vyre.app.data.ago
import sh.vyre.app.design.Glyph
import sh.vyre.app.design.Hairline
import sh.vyre.app.design.Radius
import sh.vyre.app.design.Space
import sh.vyre.app.design.Type
import sh.vyre.app.design.V

/** The phone's surface name on every write (ADR 0018): leases, sends, answers, watches. */
const val SURFACE = "android"

/** Find's segments (phone.md section 7). */
enum class Scope(val label: String) { All("All"), Chats("Chats"), Files("Files"), Memory("Memory"), Run("Run") }

/** What the searches returned for `q`: null while one is still out, a failure when it was refused. */
data class Found(val q: String, val recall: Result<List<JsonElement>>?, val files: Result<List<JsonElement>>?, val memory: Result<List<JsonElement>>?)

/**
 * Find (the Capsule, opened; phone.md section 7): a full-height sheet with the search field and
 * Done, the All / Chats / Files / Memory / Run segments, and as you type: Ask <assistant> (a new
 * lean thread, pushed as a chat), Run (the Deck's Find grammar: @agent, tell, watch, New session
 * on ...), From memory, Chats and Files, matches on --match. The search waits 150 ms after the
 * last keystroke and cancels the one before. An empty field shows recent searches and the four
 * most recent sessions.
 */
@Composable
fun FindScreen(onClose: () -> Unit = {}) {
    val app = LocalApp.current
    val nav = LocalNav.current
    val scope = rememberCoroutineScope()
    val assistant = LocalAssistant.current
    var q by rememberSaveable { mutableStateOf("") }
    var seg by rememberSaveable { mutableStateOf(Scope.All) }
    var busy by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }
    val focus = remember { FocusRequester() }
    val agents = rememberLoad("find-agents") { app.client.call("agents.list").arr.toList() }
    val threads = rememberLoad("find-threads") { app.client.call("threads.list", input("all" to true)).arr.toList() }
    val projects = rememberLoad("find-projects") { app.client.call("projects.list").at("projects").arr.toList() }
    OnEvents("thread.started", "thread.stopped") { threads.refresh() }
    val prefs = remember { app.getSharedPreferences("find", android.content.Context.MODE_PRIVATE) }
    var recent by remember { mutableStateOf(prefs.getString("recent", "")!!.split('\n').filter { it.isNotBlank() }) }
    fun keep(words: String) { recent = FindText.recents(recent, words); prefs.edit().putString("recent", recent.joinToString("\n")).apply() }

    val agentList = agents.v.value.orEmpty()
    val names = agentList.mapNotNull { it.str("name") }
    val assistantAgent = agentList.firstOrNull { it.str("kind") == "assistant" }?.str("name")
    val sessions = threads.v.value.orEmpty().sortedByDescending { it.str("last")?.toLongOrNull() ?: 0 }
    val named = sessions.mapNotNull { t -> t.str("id")?.let { Named(it, label(t)) } }
    val projectNames = projects.v.value.orEmpty().mapNotNull { p -> p.str("slug")?.let { Named(it, p.str("name") ?: it) } }
    val route = Router.route(q, names)
    val runs = remember(q, names, named, projectNames) { FindText.runs(q, names, named, projectNames) }

    // What the searches look for: the words, without a leading @agent; tell and watch only match sessions by name.
    val words = when (val r = route) { is Route.Assistant -> r.text; is Route.Agent -> r.text; else -> "" }.trim()
    var found by remember { mutableStateOf(Found("", null, null, null)) }
    LaunchedEffect(words) {
        if (words.length < 2) { found = Found("", null, null, null); return@LaunchedEffect }
        // A new keystroke restarts this effect, which cancels the wait and every request still out.
        delay(150)
        found = Found(words, null, null, null)
        coroutineScope {
            launch { val r = runCatching { app.client.call("recall.search", input("q" to words, "limit" to 12, "per_session" to 1)).arr.toList() }; found = found.copy(recall = r) }
            launch { val r = runCatching { app.client.call("files.search", input("q" to words, "limit" to 12)).at("results").arr.toList() }; found = found.copy(files = r) }
            launch {
                // memory.relevant first; an older box refuses it over the tailnet (CONTRACT.md 4.2), so memory.facts about the words is the fallback.
                val r = runCatching { app.client.call("memory.relevant", input("text" to words, "limit" to 5)).arr.toList() }
                    .recoverCatching { app.client.call("memory.facts", input("about" to words, "limit" to 5)).at("facts").arr.toList() }
                found = found.copy(memory = r)
            }
        }
    }

    fun push(thread: String?) { if (thread != null) { q = ""; nav("thread/$thread") } }

    /** Ask: a new lean thread with the question, pushed as a chat; an older box gets it through the assistant. */
    fun ask(text: String) {
        if (busy) return
        busy = true; note = null; keep(text)
        scope.launch {
            try {
                val t = runCatching { app.client.call("threads.start", input("prompt" to text, "lean" to true, "name" to "Ask: ${text.take(40)}", "surface" to SURFACE), timeoutSec = 60) }.getOrNull()
                if (t?.str("id") != null) push(t.str("id"))
                else if (assistantAgent == null) note = "This box has no assistant yet. Try @ and an agent's name."
                else {
                    val out = app.client.call("agents.ask", input("agent" to assistantAgent, "text" to text, "surface" to SURFACE, "wait" to false), timeoutSec = 60)
                    if (out.str("ok") == "false") note = out.str("note") ?: "$assistant did not take it." else push(out.str("thread"))
                }
            } catch (e: Exception) { note = e.plain() }
            busy = false
        }
    }

    fun run(r: RunRow) {
        if (busy) return
        busy = true; note = null; keep(q)
        scope.launch {
            try {
                when (r.kind) {
                    RunRow.Kind.Agent -> if (r.text.isEmpty()) { nav("agent/" + android.net.Uri.encode(r.target.orEmpty())) } else {
                        val out = app.client.call("agents.ask", input("agent" to r.target, "text" to r.text, "surface" to SURFACE, "wait" to false), timeoutSec = 60)
                        if (out.str("ok") == "false") note = out.str("note") ?: "${r.target} did not take it." else push(out.str("thread"))
                    }
                    RunRow.Kind.Drive -> {
                        val out = app.client.call("threads.send", input("thread" to r.target, "text" to r.text, "surface" to SURFACE))
                        if (out.str("sent") == "true") {
                            runCatching { app.client.call("threads.watch", input("thread" to r.target, "until" to "either", "notify" to SURFACE, "note" to r.title)) }
                            note = "Sent. You will hear when it finishes or asks."; q = ""
                        } else note = out.str("note") ?: "Another surface has that session."
                    }
                    RunRow.Kind.Watch -> {
                        app.client.call("threads.watch", input("thread" to r.target, "until" to "either", "notify" to SURFACE, "note" to r.title))
                        note = "Watching. You will hear when it finishes or asks."; q = ""
                    }
                    RunRow.Kind.NewSession -> push(app.client.call("threads.start", input("project" to r.target, "surface" to SURFACE), timeoutSec = 60).str("id"))
                }
            } catch (e: Exception) { note = e.plain() }
            busy = false
        }
    }

    /** Enter: the first Run row for a command, else Ask. */
    fun go() {
        val t = q.trim()
        if (t.isEmpty()) return
        if (route !is Route.Assistant && runs.isNotEmpty()) run(runs.first()) else if (route is Route.Assistant) ask(t)
    }

    Page(top = {
        // The Capsule, opened: the keyboard comes up with it.
        LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
        SearchTop(q, { q = it; note = null }, focus, onGo = { go() }, onDone = onClose)
        Segments(seg) { seg = it }
        Spacer(Modifier.height(Space.m))
    }) {
        note?.let { n -> item { Text(n, style = Type.meta, color = V.c.text2, modifier = Modifier.padding(bottom = Space.m)) } }
        if (q.isBlank()) { empty(recent, sessions.take(4), { q = it; runCatching { focus.requestFocus() } }, { t -> t.str("id")?.let { nav("thread/$it") } }); return@Page }

        val text = q.trim()
        val show = { s: Scope -> seg == Scope.All || seg == s }
        if (show(Scope.Run)) {
            if (route is Route.Assistant) item { AskRow(assistant, text, busy) { ask(text) } }
            if (runs.isNotEmpty()) item { RunCard(runs, text) { run(it) } }
        }
        if (words.length >= 2) {
            if (show(Scope.Memory)) memory(found, words, if (seg == Scope.Memory) 10 else 3, nav)
            if (show(Scope.Chats)) chats(found, words, sessions, if (seg == Scope.Chats) 20 else 6, nav)
            if (show(Scope.Files)) files(found, if (seg == Scope.Files) 20 else 6, nav)
        }
    }
}

/** The top row, 52 tall: the search field (40 tall, --hover, a --rule border, the magnifier, a clear button) and Done. */
@Composable
private fun SearchTop(q: String, set: (String) -> Unit, focus: FocusRequester, onGo: () -> Unit, onDone: () -> Unit) {
    val c = V.c
    val shape = RoundedCornerShape(Radius.panel)
    Row(Modifier.fillMaxWidth().heightIn(min = 52.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(Modifier.weight(1f).height(40.dp).clip(shape).background(c.hover).border(1.dp, c.rule, shape).padding(start = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Glyph.Search(c.label, 18.dp)
            Spacer(Modifier.width(Space.s))
            BasicTextField(q, set, singleLine = true, textStyle = Type.input.copy(color = c.text), cursorBrush = SolidColor(c.focus),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go), keyboardActions = KeyboardActions(onAny = { onGo() }),
                modifier = Modifier.weight(1f).focusRequester(focus).semantics { contentDescription = "Find, ask or run" },
                decorationBox = { inner -> if (q.isEmpty()) Text("Find, ask or run", style = Type.input, color = c.label, maxLines = 1); inner() })
            if (q.isNotEmpty()) Box(Modifier.size(40.dp).clickable(role = Role.Button, onClickLabel = "Clear") { set("") }, contentAlignment = Alignment.Center) { Glyph.Close(c.label, 16.dp) }
            else Spacer(Modifier.width(10.dp))
        }
        Box(Modifier.heightIn(min = 44.dp).clickable(role = Role.Button, onClick = onDone).padding(start = Space.m), contentAlignment = Alignment.Center) {
            Text("Done", style = Type.input, color = c.text)
        }
    }
}

/** The segmented control: 32 tall, radius 9, a --hover track with a --rule border, 2 inset; the selected segment --bg with a --rule-strong border. */
@Composable
private fun Segments(seg: Scope, pick: (Scope) -> Unit) {
    val c = V.c
    Row(Modifier.fillMaxWidth().height(32.dp).clip(RoundedCornerShape(9.dp)).background(c.hover).border(1.dp, c.rule, RoundedCornerShape(9.dp)).padding(2.dp)) {
        for (s in Scope.entries) {
            val on = s == seg
            Box(Modifier.weight(1f).fillMaxHeight().clip(RoundedCornerShape(7.dp)).background(if (on) c.bg else Color.Transparent)
                .border(1.dp, if (on) c.ruleStrong else Color.Transparent, RoundedCornerShape(7.dp))
                .clickable(role = Role.Tab) { pick(s) }.semantics { selected = on }, contentAlignment = Alignment.Center) {
                Text(s.label, style = Type.meta.copy(fontWeight = FontWeight(if (on) 600 else 400)), color = if (on) c.text else c.text2, maxLines = 1)
            }
        }
    }
}

/** `text` with `ranges` on --match. */
private fun highlight(text: String, ranges: List<IntRange>, match: Color): AnnotatedString = buildAnnotatedString {
    append(text)
    for (r in ranges) if (r.first >= 0 && r.last < text.length) addStyle(SpanStyle(background = match), r.first, r.last + 1)
}

/** The Ask row: the assistant's tile, "Ask <assistant>", the words as a question, on --signal-wash. */
@Composable
private fun AskRow(assistant: String, text: String, busy: Boolean, onClick: () -> Unit) {
    val c = V.c
    Row(Modifier.fillMaxWidth().padding(bottom = Space.m).clip(RoundedCornerShape(Radius.panel)).background(c.signalWash).border(1.dp, c.rule, RoundedCornerShape(Radius.panel))
        .clickable(enabled = !busy, role = Role.Button, onClick = onClick).padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Tile(assistant)
        Spacer(Modifier.width(Space.m))
        Column(Modifier.weight(1f)) {
            Text(if (busy) "Asking $assistant" else "Ask $assistant", style = Type.rowTitle, color = c.text)
            Text(FindText.question(text), style = Type.secondary, color = c.text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Glyph.Chevron(c.text2)
    }
}

/** Run: the matching commands, each its words (matches on --match) and the command it runs in mono. */
@Composable
private fun RunCard(runs: List<RunRow>, q: String, onRun: (RunRow) -> Unit) {
    val c = V.c
    Grouped(Modifier.padding(bottom = Space.m)) {
        runs.forEachIndexed { i, r ->
            if (i > 0) Hairline()
            Row(Modifier.fillMaxWidth().clickable(role = Role.Button) { onRun(r) }.padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Glyph.Terminal(c.label, 20.dp)
                Spacer(Modifier.width(Space.m))
                Column(Modifier.weight(1f)) {
                    Text(highlight(r.title, FindText.ranges(r.title, q), c.match), style = Type.rowTitle, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(r.command, style = Type.monoSmall, color = c.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

/** A section's header in Group type (17/600). */
@Composable
private fun Head(text: String) { Text(text, style = Type.group, color = V.c.text, modifier = Modifier.padding(top = Space.s, bottom = Space.s)) }

/** Under a section while its search is out, or when it failed: one quiet line. */
private fun LazyListScope.pending(r: Result<List<JsonElement>>?, what: String) {
    when {
        r == null -> item { Text("Looking", style = Type.meta, color = V.c.label, modifier = Modifier.padding(bottom = Space.m)) }
        r.isFailure -> item { sh.vyre.app.design.Failure("$what: ${r.exceptionOrNull()?.plain().orEmpty()}", Modifier.padding(bottom = Space.m)) }
    }
}

/** From memory: the facts, matches on --match, their source and age under each (--text-2 on the tint). */
private fun LazyListScope.memory(f: Found, q: String, max: Int, nav: (String) -> Unit) {
    val facts = f.memory?.getOrNull().orEmpty().filter { !it.str("text").isNullOrBlank() }.take(max)
    if (facts.isEmpty()) { pending(f.memory, "Memory was not searched"); return }
    item {
        val c = V.c
        Column(Modifier.fillMaxWidth().padding(bottom = Space.m).clip(RoundedCornerShape(Radius.panel)).background(c.recallWash).padding(horizontal = 14.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(Space.m)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Glyph.History(c.recall, 14.dp); Spacer(Modifier.width(6.dp))
                Text("From memory", style = Type.meta.copy(fontWeight = FontWeight(600)), color = c.recall)
            }
            for (m in facts) Column(Modifier.fillMaxWidth().clickable { nav(m.str("id")?.let { "fact/" + android.net.Uri.encode(it) } ?: ("memory/" + android.net.Uri.encode(q))) }) {
                val t = m.str("text").orEmpty()
                Text(highlight(t, FindText.ranges(t, q), c.match), style = Type.secondary.copy(lineHeight = 21.sp), color = c.text)
                dots(m.str("source"), m.str("age")).takeIf { it.isNotBlank() }?.let { Text(it, style = Type.micro, color = c.text2) }
            }
        }
    }
}

/** Chats: sessions whose name matches, then recall.search's hits, each with its snippet and "<project> · <date>". */
private fun LazyListScope.chats(f: Found, q: String, live: List<JsonElement>, max: Int, nav: (String) -> Unit) {
    val byName = live.filter { Router.match(q, label(it)) >= 0.5 }
    val hits = f.recall?.getOrNull().orEmpty().filter { h -> byName.none { it.str("id") == h.str("session") } }
    val rows = (byName.map { t -> Triple(t.str("id"), label(t), null as String?) to dots(t.str("project"), ago(t.str("last")?.toLongOrNull())) } +
        hits.map { h -> Triple(h.str("session"), h.str("title") ?: h.str("name") ?: h.str("session").orEmpty().take(8), h.str("snippet") ?: h.str("text")) to
            dots(h.str("cwd")?.substringAfterLast('/'), h.str("ts")?.toLongOrNull()?.let { ago(it) }) }).take(max)
    if (rows.isEmpty()) { pending(f.recall, "Sessions were not searched"); if (f.recall?.isSuccess == true) item { Head("Chats"); Text("No session says that.", style = Type.meta, color = V.c.label, modifier = Modifier.padding(bottom = Space.m)) }; return }
    item { Head("Chats") }
    item {
        val c = V.c
        Grouped(Modifier.padding(bottom = Space.m)) {
            rows.forEachIndexed { i, (r, meta) ->
                val (id, name, snippet) = r
                if (i > 0) Hairline()
                Column(Modifier.fillMaxWidth().clickable(role = Role.Button) { id?.let { nav("thread/$it") } }.padding(horizontal = 14.dp, vertical = 12.dp)) {
                    Text(highlight(name, FindText.ranges(name, q), c.match), style = Type.rowTitle, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    snippet?.let { s ->
                        val (clean, marks) = FindText.marked(s)
                        Text(highlight(clean, marks.ifEmpty { FindText.ranges(clean, q) }, c.match), style = Type.secondary, color = c.text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    if (meta.isNotBlank()) Text(meta, style = Type.meta, color = c.label)
                }
            }
        }
    }
}

/** Files: the box's (a phone cannot reach a Mac's files yet, and one line says so). */
private fun LazyListScope.files(f: Found, max: Int, nav: (String) -> Unit) {
    val files = f.files?.getOrNull().orEmpty().take(max)
    item { Head("Files") }
    if (files.isEmpty()) pending(f.files, "Files were not searched")
    if (files.isNotEmpty()) item {
        val c = V.c
        Grouped {
            files.forEachIndexed { i, x ->
                if (i > 0) Hairline()
                Row(Modifier.fillMaxWidth().clickable(role = Role.Button) { x.str("path")?.let { nav("file/" + android.net.Uri.encode(it)) } }.padding(horizontal = 14.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Glyph.File(c.label, 20.dp)
                    Spacer(Modifier.width(Space.m))
                    Column(Modifier.weight(1f)) {
                        Text(sh.vyre.app.data.ChatText.short(x.str("path").orEmpty()), style = Type.command, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(dots(x.str("path")?.substringBeforeLast('/')?.substringAfterLast('/'), x.str("source") ?: "box"), style = Type.meta, color = c.label, maxLines = 1)
                    }
                }
            }
        }
    }
    item { Text("Files on your Macs are not reachable from this phone yet; these are on the box.", style = Type.meta, color = V.c.label, modifier = Modifier.padding(top = Space.s, bottom = Space.m)) }
}

/** The empty field: recent searches, then the four most recent sessions. */
private fun LazyListScope.empty(recent: List<String>, sessions: List<JsonElement>, pick: (String) -> Unit, open: (JsonElement) -> Unit) {
    if (recent.isNotEmpty()) {
        item { Head("Recent") }
        item {
            Grouped(Modifier.padding(bottom = Space.m)) {
                recent.forEachIndexed { i, r ->
                    if (i > 0) Hairline()
                    Row(Modifier.fillMaxWidth().heightIn(min = 44.dp).clickable(role = Role.Button) { pick(r) }.padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Glyph.Search(V.c.label, 16.dp); Spacer(Modifier.width(Space.m))
                        Text(r, style = Type.secondary, color = V.c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }
    if (sessions.isNotEmpty()) {
        item { Head("Sessions") }
        item {
            Grouped {
                sessions.forEachIndexed { i, t ->
                    if (i > 0) Hairline()
                    Column(Modifier.fillMaxWidth().clickable(role = Role.Button) { open(t) }.padding(horizontal = 14.dp, vertical = 12.dp)) {
                        Text(label(t), style = Type.rowTitle, color = V.c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(dots(t.str("project"), ago(t.str("last")?.toLongOrNull())), style = Type.meta, color = V.c.label)
                    }
                }
            }
        }
    }
}

/** A session's name as people say it. */
fun label(t: JsonElement): String = t.str("name")?.takeIf { it.isNotBlank() } ?: t.str("id").orEmpty().take(8)

/** loadState for a list inside a LazyListScope, under a heading. */
fun LazyListScope.loadStateItems(l: Load<*>, empty: Boolean, emptyText: String) = loadState(l, empty, emptyText)
