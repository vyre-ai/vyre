package sh.vyre.app.ui

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import sh.vyre.app.api.ApiError
import sh.vyre.app.api.arr
import sh.vyre.app.api.at
import sh.vyre.app.api.input
import sh.vyre.app.api.long
import sh.vyre.app.api.obj
import sh.vyre.app.api.plain
import sh.vyre.app.api.str
import sh.vyre.app.api.flatten
import sh.vyre.app.data.Line
import sh.vyre.app.data.Transcript
import sh.vyre.app.data.ago
import sh.vyre.app.data.money
import sh.vyre.app.design.ButtonKind
import sh.vyre.app.design.Dot
import sh.vyre.app.design.Hairline
import sh.vyre.app.design.Label
import sh.vyre.app.design.Radius
import sh.vyre.app.design.SectionHead
import sh.vyre.app.design.Space
import sh.vyre.app.design.Type
import sh.vyre.app.design.V
import sh.vyre.app.design.VButton

/** Projects (a tab, as in the PWA): the projects on the box; a project opens its sessions. */
@Composable
fun ProjectsScreen() {
    val app = LocalApp.current
    val nav = LocalNav.current
    val load = rememberLoad("projects") { app.client.call("projects.list") }
    val projects = load.v.value.at("projects").arr
    Page(top = { BrandBar() }) {
        item { Text("Projects", style = Type.h1, color = V.c.text, modifier = Modifier.padding(top = Space.s)) }
        item { SectionHead("Projects · ${projects.size}") }
        loadState(load.v, projects.isEmpty(), "No projects yet. Make one on the Mac with vyre new.")
        items(projects, key = { "p" + it.str("slug") }) { p ->
            Row2(p.str("name") ?: p.str("slug").orEmpty(),
                dots(p.str("org"), "${p.str("threads") ?: 0} sessions", ago(p.str("last")?.toLongOrNull())),
                onClick = { nav("project/${p.str("slug")}") })
        }
    }
}

/**
 * Chat (a tab): sessions and threads. Live ones first (running, starting, waiting), then the
 * others from the last day; each opens the thread.
 */
@Composable
fun ChatScreen() {
    val app = LocalApp.current
    val nav = LocalNav.current
    val load = rememberLoad("threads-all") { app.client.call("threads.list", input("all" to true)).arr.toList() }
    OnEvents("thread.started", "thread.finished", "thread.stopped", "ask.raised", "ask.answered") { load.refresh() }
    val all = load.v.value.orEmpty().sortedByDescending { it.str("last")?.toLongOrNull() ?: 0 }
    val live = all.filter { it.str("status") in setOf("working", "starting", "waiting") }
    val rest = all.filter { it !in live }
    Page(top = { BrandBar() }) {
        item { Text("Chat", style = Type.h1, color = V.c.text, modifier = Modifier.padding(top = Space.s)) }
        item { SectionHead("Live · ${live.size}") }
        if (load.v.value != null && live.isEmpty()) item { Quiet("No session is running. Start one from a project.") }
        items(live, key = { "l" + it.str("id") }) { t ->
            Row2(label(t), dots(t.str("agent"), t.str("project"), if (t.str("status") == "waiting") "waiting on you" else t.str("status")),
                subColor = if (t.str("status") == "waiting") V.c.beacon else null,
                leading = { Dot(if (t.str("status") == "waiting") V.c.beaconDot else V.c.focus) },
                onClick = { nav("thread/${t.str("id")}") })
        }
        item { SectionHead("Sessions · ${rest.size}") }
        loadState(load.v, all.isEmpty(), "No session in the last day.")
        items(rest, key = { "s" + it.str("id") }) { t ->
            Row2(label(t), dots(t.str("agent"), t.str("project"), ago(t.str("last")?.toLongOrNull())), onClick = { nav("thread/${t.str("id")}") })
        }
    }
}

@Composable
fun ProjectScreen(slug: String, onBack: () -> Unit) {
    val app = LocalApp.current
    val nav = LocalNav.current
    val scope = rememberCoroutineScope()
    val projects = rememberLoad("projects") { app.client.call("projects.list") }
    val load = rememberLoad(slug) { app.client.call("projects.threads", input("project" to slug, "limit" to 100)).arr.toList() }
    val p = projects.v.value.at("projects").arr.firstOrNull { it.str("slug") == slug }
    var prompt by remember { mutableStateOf("") }
    var note by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    Page(top = { BackBar("Projects", onBack) }) {
        item {
            Text(p?.str("name") ?: slug, style = Type.h2, color = V.c.text)
            p?.at("people")?.arr?.takeIf { it.isNotEmpty() }?.let { people -> Text(people.joinToString(", ") { it.str("name").orEmpty() }, style = Type.small, color = V.c.secondary) }
            SectionHead("New session")
            Composer(prompt, { prompt = it }, placeholder = "What should it do?", busy = busy, onSend = {
                busy = true; note = null
                scope.launch {
                    try {
                        val rec = app.client.call("threads.start", input("project" to slug, "prompt" to prompt.trim(), "surface" to "android"))
                        prompt = ""
                        rec.str("id")?.let { nav("thread/$it") }
                    } catch (e: Exception) { note = e.plain() }
                    busy = false
                }
            })
            note?.let { Quiet(it) }
            SectionHead("Sessions · ${load.v.value?.size ?: 0}")
        }
        loadState(load.v, load.v.value.isNullOrEmpty(), "No sessions in this project yet.")
        items(load.v.value.orEmpty(), key = { "s" + it.str("id") }) { s ->
            Row2(s.str("title") ?: s.str("label") ?: s.str("name") ?: s.str("id").orEmpty().take(8),
                listOfNotNull("${s.str("turns") ?: 0} turns", ago(s.str("last")?.toLongOrNull()).takeIf { it.isNotEmpty() }, "missing".takeIf { s.str("missing") == "true" }).joinToString(" · "),
                onClick = { nav("thread/${s.str("id")}") })
        }
    }
}

/**
 * A thread: the terminal, mirrored. History from threads.get, then live events; the composer
 * shows who holds the keyboard and takes the lease on focus, renewing it every 60 s while
 * focused and in front, and releasing it on blur.
 */
@Composable
fun ThreadScreen(id: String, onBack: () -> Unit) {
    val app = LocalApp.current
    val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current
    val transcript = remember(id) { Transcript(id) }
    var version by remember { mutableIntStateOf(0) }
    var record by remember { mutableStateOf<JsonElement?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var holder by remember { mutableStateOf<String?>(null) }
    var text by remember { mutableStateOf("") }
    var focused by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }

    suspend fun reload() {
        try {
            val g = app.client.call("threads.get", input("thread" to id, "limit" to 400))
            record = g.at("thread")
            holder = record.str("holder")
            for (e in g.at("events").arr) transcript.add(flatten(e))
            for (a in g.at("asks").arr) if (a.str("state") == "open") transcript.openAsk(a.obj)
            if (transcript.status == null || transcript.status == "working") transcript.setStatus(record.str("status"))
            version++
            error = null
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            // Not a live thread: a session that ran in a terminal. Show its recorded turns, read-only in effect.
            try {
                val r = app.client.call("recall.thread", input("session" to id, "limit" to 400))
                val sess = r.at("session")
                record = JsonObject(mapOf("name" to kotlinx.serialization.json.JsonPrimitive(sess.str("title") ?: sess.str("name") ?: "Session"), "status" to kotlinx.serialization.json.JsonPrimitive("recorded")))
                for (t in r.at("turns").arr) transcript.turn(t.long("seq"), t.str("role"), t.str("text").orEmpty(), t.long("ts"))
                transcript.setStatus("recorded")
                version++
                error = null
            } catch (e2: Exception) { if (e2 is kotlinx.coroutines.CancellationException) throw e2; error = e.plain() }
        }
    }
    LaunchedEffect(id) { reload() }
    OnEvents("thread.*", "ask.*", "gate.*", "lease.changed") { e ->
        if (e.str("thread") != id) return@OnEvents
        if (e.str("type") == "lease.changed") { holder = e.str("holder"); return@OnEvents }
        if (transcript.add(e)) version++
        // A thread that finished while away lost its deltas; the final text comes with done.
    }
    // The lease: taken on focus, renewed every 60 s only while focused and in front, released on blur.
    LaunchedEffect(focused) {
        if (!focused) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                runCatching { app.client.call("threads.lease", input("thread" to id, "surface" to "android")) }.onSuccess { holder = it.str("holder") }
                delay(60_000)
            }
        }
    }
    val list = rememberLazyListState()
    val lines = remember(version) { transcript.items }
    LaunchedEffect(lines.size) { if (lines.isNotEmpty()) list.animateScrollToItem(lines.size) }
    val status = transcript.status ?: record.str("status")
    val c = V.c

    Column(Modifier.fillMaxSize().background(c.ground).statusBarsPadding().imePadding()) {
        Column(Modifier.padding(horizontal = Space.gutter)) {
            BackBar(record.str("project") ?: "Chat", onBack) {
                if (status == "working" || status == "waiting" || status == "starting")
                    VButton("Stop", kind = ButtonKind.Quiet, onClick = { scope.launch { runCatching { app.client.call("threads.stop", input("thread" to id)) }; reload() } })
            }
            Text(record.str("name") ?: "Session", style = Type.h3, color = c.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Label(listOfNotNull(record.str("agent"), status, record.str("model")).joinToString(" · "), Modifier.padding(top = 2.dp, bottom = Space.s))
            Hairline()
        }
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = list, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = Space.gutter, vertical = Space.m), verticalArrangement = Arrangement.spacedBy(Space.m)) {
            if (error != null && lines.isEmpty()) item { Quiet(error!!, "failed") }
            items(lines, key = { it.key }) { l -> LineView(l) }
            item { Spacer(Modifier.size(1.dp)) }
        }
        Column(Modifier.padding(horizontal = Space.gutter, vertical = Space.s)) {
            val mine = holder == "android"
            Label(when { holder == null -> "No one has the keyboard"; mine -> "You have the keyboard"; else -> "$holder has the keyboard" },
                Modifier.padding(bottom = 6.dp), if (mine) c.focus else c.label)
            Composer(text, { text = it }, placeholder = if (holder != null && !mine) "Typing here takes it from $holder" else "Reply", busy = busy,
                onFocus = { f ->
                    focused = f
                    if (!f && holder == "android") scope.launch { runCatching { app.client.call("threads.release", input("thread" to id, "surface" to "android")) }.onSuccess { holder = it.str("holder") } }
                },
                onSend = {
                    val t = text.trim()
                    busy = true; note = null
                    scope.launch {
                        try {
                            val out = app.client.call("threads.send", input("thread" to id, "text" to t, "surface" to "android"))
                            if (out.str("sent") == "true") { transcript.echo(t); version++; text = "" }
                            else note = out.str("note") ?: "Not sent: ${out.str("holder")} has the keyboard."
                        } catch (e: Exception) { note = e.plain() }
                        busy = false
                    }
                })
            note?.let { Text(it, style = Type.small, color = c.secondary, modifier = Modifier.padding(top = 4.dp)) }
        }
    }
}

@Composable
fun LineView(l: Line) {
    val c = V.c
    when (l) {
        is Line.User -> Column(Modifier.fillMaxWidth()) {
            Label(listOfNotNull(if (l.surface == null || l.surface == "android") "You" else "You · ${l.surface}", ago(l.at).takeIf { it.isNotEmpty() }).joinToString(" · "))
            Text(l.text, style = Type.body, color = c.secondary, modifier = Modifier.padding(top = 4.dp))
        }
        is Line.Assistant -> Md(l.text.ifEmpty { "…" })
        is Line.Notice -> Text(l.text, style = Type.small, color = c.label)
        is Line.Tools -> ToolBlock(l)
        is Line.Ask -> AskItem(JsonObject(mapOf("id" to kotlinx.serialization.json.JsonPrimitive(l.ask), "summary" to kotlinx.serialization.json.JsonPrimitive(l.summary),
            "destination" to (l.destination?.let { kotlinx.serialization.json.JsonPrimitive(it) } ?: kotlinx.serialization.json.JsonNull),
            "reason" to (l.reason?.let { kotlinx.serialization.json.JsonPrimitive(it) } ?: kotlinx.serialization.json.JsonNull),
            "decision" to (l.decision?.let { kotlinx.serialization.json.JsonPrimitive(it) } ?: kotlinx.serialization.json.JsonNull))), null, onDone = {})
        is Line.Held -> Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.panel)).background(c.beaconWash).padding(Space.l)) {
            if (l.state == "held") HeldItem(l.id, onDone = {}, inline = true) else Text(if (l.state == "sent") "Sent after you approved it." else "Discarded.", style = Type.small, color = c.secondary)
        }
        is Line.Finished -> Row(verticalAlignment = Alignment.CenterVertically) {
            Hairline(Modifier.weight(1f)); Spacer(Modifier.width(Space.s))
            Label(listOfNotNull(if (l.ok) "Done" else "Failed", l.durationMs?.let { "${it / 1000} s" }, money(l.cost).takeIf { it.isNotEmpty() }).joinToString(" · "))
            Spacer(Modifier.width(Space.s)); Hairline(Modifier.weight(1f))
        }
        is Line.Stopped -> Label("Stopped · ${l.reason}")
    }
}

/** Consecutive tool calls, folded: one line with the latest summary and where it went; tap for all of them. */
@Composable
fun ToolBlock(l: Line.Tools) {
    val c = V.c
    var open by remember { mutableStateOf(false) }
    val last = l.calls.last()
    val failed = l.calls.count { it.error }
    val running = l.calls.any { !it.done }
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.button)).background(c.panel).animateContentSize()
        .clickable(role = Role.Button, onClickLabel = if (open) "Fold tool calls" else "Show tool calls") { open = !open }.padding(horizontal = Space.m, vertical = 10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Dot(if (failed > 0) c.beaconDot else if (running) c.text else c.label)
            Spacer(Modifier.width(Space.s))
            Text(if (l.calls.size == 1) last.tool else "${l.calls.size} tools", style = Type.monoSmall, color = c.label)
            Spacer(Modifier.width(Space.s))
            Text(last.summary, style = Type.monoSmall, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        }
        if (!open && last.destination != null && last.destination != last.summary) Text(last.destination, style = Type.monoSmall, color = c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 14.dp))
        if (open) for (t in l.calls) Row(Modifier.padding(top = 6.dp), verticalAlignment = Alignment.Top) {
            Dot(if (t.error) c.beaconDot else if (!t.done) c.text else c.label, modifier = Modifier.padding(top = 5.dp))
            Spacer(Modifier.width(Space.s))
            Column(Modifier.weight(1f)) {
                Text("${t.tool}  ${t.summary}", style = Type.monoSmall, color = c.text)
                if (t.destination != null && t.destination != t.summary) Text(t.destination, style = Type.monoSmall, color = c.secondary)
            }
            if (t.error) Label("failed")
        }
    }
}

/** A text field on carbon with the send arrow; Signal only on the arrow and the focus ring. */
@Composable
fun Composer(value: String, onChange: (String) -> Unit, placeholder: String, busy: Boolean, onSend: () -> Unit, onFocus: (Boolean) -> Unit = {}, prefix: String? = null) {
    val c = V.c
    var focused by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.panel)).background(c.panel)
        .border(1.dp, if (focused) c.focus else c.ruleStrong, RoundedCornerShape(Radius.panel)).padding(start = Space.m, end = 6.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically) {
        if (prefix != null) { Text(prefix, style = Type.code, color = c.label); Spacer(Modifier.width(Space.s)) }
        Column(Modifier.weight(1f).padding(vertical = 8.dp)) {
            BasicTextField(value, onChange, textStyle = Type.body.copy(color = c.text), cursorBrush = SolidColor(c.focus), maxLines = 6,
                modifier = Modifier.fillMaxWidth().onFocusChanged { focused = it.isFocused; onFocus(it.isFocused) }.semantics { contentDescription = placeholder },
                decorationBox = { inner -> if (value.isEmpty()) Text(placeholder, style = Type.body, color = c.label); inner() })
        }
        val can = value.isNotBlank() && !busy
        Column(Modifier.size(44.dp).clip(RoundedCornerShape(Radius.button)).background(if (can) c.primaryFill else c.raised)
            .clickable(enabled = can, role = Role.Button, onClickLabel = "Send", onClick = onSend), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            Icon(Icons.AutoMirrored.Filled.ArrowForward, "Send", tint = if (can) c.primaryInk else c.label, modifier = Modifier.size(20.dp))
        }
    }
}
