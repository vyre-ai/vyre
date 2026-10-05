package sh.vyre.app.ui

import android.os.Build
import android.view.HapticFeedbackConstants
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import sh.vyre.app.api.ApiError
import sh.vyre.app.api.arr
import sh.vyre.app.api.at
import sh.vyre.app.api.flatten
import sh.vyre.app.api.input
import sh.vyre.app.api.long
import sh.vyre.app.api.obj
import sh.vyre.app.api.plain
import sh.vyre.app.api.str
import sh.vyre.app.data.Anchor
import sh.vyre.app.data.AskView
import sh.vyre.app.data.ChatText
import sh.vyre.app.data.Gate
import sh.vyre.app.data.Line
import sh.vyre.app.data.Needs
import sh.vyre.app.data.Pick
import sh.vyre.app.data.Questions
import sh.vyre.app.data.Speaker
import sh.vyre.app.data.ToolCall
import sh.vyre.app.data.Transcript
import sh.vyre.app.data.ago
import sh.vyre.app.data.answerInput
import sh.vyre.app.data.money
import sh.vyre.app.data.speakerOf
import sh.vyre.app.design.ButtonKind
import sh.vyre.app.design.Dot
import sh.vyre.app.design.Failure
import sh.vyre.app.design.Glyph
import sh.vyre.app.design.Hairline
import sh.vyre.app.design.Radius
import sh.vyre.app.design.SectionHead
import sh.vyre.app.design.Space
import sh.vyre.app.design.Type
import sh.vyre.app.design.V
import sh.vyre.app.design.VButton
import kotlin.math.abs
import kotlin.math.roundToInt

/** The live states of a thread record. */
private val RUNNING = setOf("working", "starting", "waiting")

/** Sessions archived on this phone (no archive tool on the box yet): hidden from Chats until they run again. */
private fun archivedOf(app: sh.vyre.app.VyreApp): MutableSet<String> =
    app.getSharedPreferences("chats", android.content.Context.MODE_PRIVATE).getStringSet("archived", emptySet())!!.toMutableSet()

private fun setArchived(app: sh.vyre.app.VyreApp, ids: Set<String>) =
    app.getSharedPreferences("chats", android.content.Context.MODE_PRIVATE).edit().putStringSet("archived", ids.toSet()).apply()

/**
 * Chats (a page, phone.md section 6): the project chips across the top (All, then each
 * project), then one card of sessions, newest first. A row: the agent's tile, the session's
 * name, the time (or, when it has asks open, the attention dot and their count), its last line,
 * and "<agent> · <project>" with a dot while it runs. Tap opens it; swipe left archives it.
 * Events drive it; the fallback read is every 60 s while it is on screen.
 */
@Composable
fun ChatScreen() {
    val app = LocalApp.current
    val nav = LocalNav.current
    val toast = LocalToast.current
    val onScreen = LocalOnScreen.current
    val lifecycle = LocalLifecycleOwner.current
    val assistant = LocalAssistant.current
    val load = rememberLoad("threads-all") { app.client.call("threads.list", input("all" to true)).arr.toList() }
    val projects = rememberLoad("projects") { app.client.call("projects.list").at("projects").arr.toList() }
    OnEvents("thread.started", "thread.finished", "thread.stopped", "ask.raised", "ask.answered") { load.refresh() }
    OnEvents("thread.text", "thread.sent") { e -> lastWords(app, e) }
    LaunchedEffect(onScreen) {
        if (!onScreen) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { while (true) { delay(60_000); load.refresh() } }
    }
    var archived by remember { mutableStateOf(archivedOf(app).toSet()) }
    var chip by rememberSaveable { mutableStateOf<String?>(null) }
    // A session that runs again comes back from the archive.
    val list = load.v.value.orEmpty()
    LaunchedEffect(list) {
        val back = list.filter { it.str("id") in archived && it.str("status") in RUNNING }.mapNotNull { it.str("id") }
        if (back.isNotEmpty()) { archived = archived - back.toSet(); setArchived(app, archived) }
    }
    val all = list.filter { (chip == null || it.str("project") == chip) && it.str("id") !in archived }
        .sortedByDescending { it.str("last")?.toLongOrNull() ?: 0 }

    fun archive(t: JsonElement) {
        val id = t.str("id") ?: return
        archived = archived + id; setArchived(app, archived)
        toast(Toast("Archived ${label(t)}", "Undo", 4000, onAction = { archived = archived - id; setArchived(app, archived) }))
    }

    Page(top = { ProjectChips(projects.v.value.orEmpty(), chip) { chip = it } }) {
        loadState(load.v, all.isEmpty(), if (chip == null) "No sessions yet. Ask Lumen to start one." else "No sessions in this project in the last day.")
        if (all.isNotEmpty()) item {
            Grouped(Modifier.padding(top = Space.s)) {
                all.forEachIndexed { i, t ->
                    if (i > 0) Hairline()
                    SessionRow(t, app.lastLines[t.str("id")], Speaker.reply(t.str("agent"), assistant), onOpen = { t.str("id")?.let { nav("thread/$it") } }, onArchive = { archive(t) })
                }
            }
        }
    }
}

/** Keep a session's last words from the stream: a finished reply, or what was typed. */
private fun lastWords(app: sh.vyre.app.VyreApp, e: JsonObject) {
    val t = e.str("thread") ?: return
    val text = when (e.str("type")) {
        "thread.sent" -> e.str("text")
        "thread.text" -> if (e.str("done") == "true" && e.str("notice") != "true") e.str("text") else null
        else -> null
    } ?: return
    val line = text.replace(Regex("\\s+"), " ").trim()
    if (line.isNotEmpty()) app.lastLines[t] = line.take(200)
}

/** A session in the Chats card, with swipe left to archive (also an accessibility action). */
@Composable
private fun SessionRow(t: JsonElement, last: String?, agent: String, onOpen: () -> Unit, onArchive: () -> Unit) {
    val c = V.c
    val scope = rememberCoroutineScope()
    val max = with(LocalDensity.current) { 100.dp.toPx() }
    val offset = remember(t.str("id")) { Animatable(0f) }
    val density = LocalDensity.current
    val running = t.str("status") in RUNNING
    val asks = t.long("asks") ?: 0L
    fun commit() { scope.launch { offset.animateTo(-max * 4, tween(160)); onArchive(); offset.snapTo(0f) } }
    Box(Modifier.fillMaxWidth().height(IntrinsicSize.Min)
        .semantics {
            contentDescription = listOfNotNull(label(t), agent, t.str("project"), if (asks > 0) "$asks waiting on you" else null, if (running) "running" else null, last).joinToString(", ")
            customActions = listOf(CustomAccessibilityAction("Open") { onOpen(); true }, CustomAccessibilityAction("Archive") { onArchive(); true })
        }
        .pointerInput(t.str("id")) {
            val vt = VelocityTracker()
            detectHorizontalDragGestures(
                onDragStart = { vt.resetTracking() },
                onDragEnd = {
                    val v = vt.calculateVelocity().x
                    when {
                        offset.value <= -max || (v < -1500f && offset.value < 0f) -> commit()
                        offset.value < -max * 0.4f -> scope.launch { offset.animateTo(-max, spring(dampingRatio = 1f)) }
                        else -> scope.launch { offset.animateTo(0f, spring(dampingRatio = 1f)) }
                    }
                },
                onDragCancel = { scope.launch { offset.animateTo(0f, spring(dampingRatio = 1f)) } },
            ) { change, dx ->
                vt.addPosition(change.uptimeMillis, change.position)
                change.consume()
                scope.launch { offset.snapTo((offset.value + dx).coerceIn(-max * 1.6f, 0f)) }
            }
        }) {
        val x = offset.value
        if (x < 0f) Box(Modifier.align(Alignment.CenterEnd).fillMaxHeight().width(with(density) { (-x).toDp() }).background(c.hover).clickable { commit() },
            contentAlignment = Alignment.Center) {
            Text("Archive", style = Type.meta.copy(fontWeight = FontWeight(600)), color = c.text, maxLines = 1)
        }
        Row(Modifier.offset { IntOffset(x.roundToInt(), 0) }.fillMaxWidth().background(c.panel).clickable(onClick = onOpen).padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.Top) {
            Tile(t.str("agent") ?: agent)
            Spacer(Modifier.width(Space.m))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(label(t), style = Type.rowTitle, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    Spacer(Modifier.width(Space.s))
                    if (asks > 0) { Dot(c.beaconDot, 7.dp); Spacer(Modifier.width(4.dp)); Text("$asks", style = Type.meta, color = c.beaconInk) }
                    else Text(Needs.short(t.str("last")?.toLongOrNull()), style = Type.meta, color = c.label)
                }
                if (!last.isNullOrBlank()) Text(last, style = Type.secondary, color = c.text2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
                Row(Modifier.padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (running) { Dot(c.text, 7.dp); Spacer(Modifier.width(6.dp)) }
                    Text(dots(agent, t.str("project")), style = Type.meta, color = c.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

/** The chips over Chats (phone.md section 6): All, then each project. */
@Composable
private fun ProjectChips(projects: List<JsonElement>, selected: String?, pick: (String?) -> Unit) {
    val items = listOf<Pair<String?, String>>(null to "All") + projects.mapNotNull { p -> p.str("slug")?.let { it to (p.str("name") ?: it) } }
    androidx.compose.foundation.lazy.LazyRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.s)) {
        items(items, key = { it.first ?: "*" }) { (slug, name) -> sh.vyre.app.design.Chip(name, onClick = { pick(slug) }, selected = slug == selected) }
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
            p?.at("people")?.arr?.takeIf { it.isNotEmpty() }?.let { people -> Text(people.joinToString(", ") { it.str("name").orEmpty() }, style = Type.small, color = V.c.text2) }
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

/** A transcript page: the last 50 events, then 100 more each time the top is reached, up to the box's 1000. */
private const val PAGE = 50
private const val MAX_EVENTS = 1000

/**
 * A session (pushed, phone.md section 6): the nav bar ("< Chats", the name with "<agent> ·
 * <project>" under it, and a more menu), the transcript (you on the right in a bubble, the agent
 * with its tile and name, tool rows grouped in one box, the reply growing with a caret, the
 * approval and question cards, time stamps at gaps of an hour), and the composer. It loads the
 * last 50 events and pages back at the top. Open session lands here with an anchor: that line is
 * centred and flashes --match for 1.2 s. The composer takes the lease on focus, renews it every
 * 60 s while focused and in front, and releases it on blur; sending takes it from whoever holds it.
 */
@Composable
fun ThreadScreen(id: String, anchor: Anchor = Anchor(), onBack: () -> Unit) {
    val app = LocalApp.current
    val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current
    val toast = LocalToast.current
    val view = LocalView.current
    val assistant = LocalAssistant.current
    var transcript by remember(id) { mutableStateOf(Transcript(id)) }
    var version by remember { mutableIntStateOf(0) }
    var record by remember { mutableStateOf<JsonElement?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var holder by remember { mutableStateOf<String?>(null) }
    var text by remember { mutableStateOf("") }
    var focused by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var limit by remember(id) { mutableIntStateOf(PAGE) }
    var more by remember(id) { mutableStateOf(false) }
    var paging by remember(id) { mutableStateOf(false) }
    var recorded by remember(id) { mutableStateOf(false) }

    /** Read the thread: a live one with threads.get (the newest `limit` events), else its recorded turns. */
    suspend fun reload(fresh: Boolean = false) {
        try {
            val g = app.client.call("threads.get", input("thread" to id, "limit" to limit))
            val t = if (fresh) Transcript(id) else transcript
            record = g.at("thread")
            holder = record.str("holder")
            val events = g.at("events").arr
            for (e in events) t.add(flatten(e))
            for (a in g.at("asks").arr) if (a.str("state") == "open") t.openAsk(a.obj)
            if (t.status == null || t.status == "working") t.setStatus(record.str("status"))
            more = events.size >= limit && limit < MAX_EVENTS
            transcript = t
            version++
            error = null
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            // Not a live thread: a session that ran in a terminal. Its recorded turns, read-only.
            try {
                val r = app.client.call("recall.thread", input("session" to id, "limit" to 400))
                val sess = r.at("session")
                val t = Transcript(id)
                record = JsonObject(mapOf("name" to JsonPrimitive(sess.str("title") ?: sess.str("name") ?: "Session"), "status" to JsonPrimitive("recorded")))
                for (x in r.at("turns").arr) t.turn(x.long("seq"), x.str("role"), x.str("text").orEmpty(), x.long("ts"))
                t.setStatus("recorded")
                recorded = true; more = false
                transcript = t
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
    }
    // The lease: taken on focus, renewed every 60 s only while focused and in front, released on blur.
    LaunchedEffect(focused) {
        if (!focused || recorded) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                runCatching { app.client.call("threads.lease", input("thread" to id, "surface" to SURFACE)) }.onSuccess { holder = it.str("holder") }
                delay(60_000)
            }
        }
    }
    val list = rememberLazyListState()
    val lines = remember(version) { transcript.items }
    val stamps = remember(version) { ChatText.stamps(lines.map { transcript.at(it.key) }) }

    // Open session: find the anchor's line, paging back while it is older than what is loaded.
    var target by remember(id) { mutableStateOf(if (anchor.empty) null else anchor) }
    var flash by remember(id) { mutableStateOf<String?>(null) }
    LaunchedEffect(version) {
        val a = target
        if (a != null) {
            val i = transcript.locate(a)
            if (i == null) {
                if (transcript.older(a) && more) { limit = (limit + 200).coerceAtMost(MAX_EVENTS); reload(fresh = true) } else target = null
                return@LaunchedEffect
            }
            target = null
            list.scrollToItem(i)
            val info = list.layoutInfo
            val size = info.visibleItemsInfo.firstOrNull { it.index == i }?.size ?: 0
            list.animateScrollToItem(i, -((info.viewportEndOffset - info.viewportStartOffset) / 2 - size / 2).coerceAtLeast(0))
            flash = lines.getOrNull(i)?.key
            delay(1200); flash = null
        } else if (lines.isNotEmpty() && !paging) {
            // New lines keep the view at the bottom only when it was there (or on the first load).
            val lastSeen = list.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: -1
            if (version <= 1 || lastSeen >= lines.size - 2) list.scrollToItem(lines.size)
        }
    }
    // Paging back: at the top, 100 more events; the line that was first stays where it was.
    val atTop by remember { androidx.compose.runtime.derivedStateOf { list.firstVisibleItemIndex == 0 && list.firstVisibleItemScrollOffset == 0 } }
    LaunchedEffect(atTop, more) {
        if (!atTop || !more || paging || target != null || lines.isEmpty()) return@LaunchedEffect
        paging = true
        val keep = lines.first().key
        limit = (limit + 100).coerceAtMost(MAX_EVENTS)
        reload(fresh = true)
        val i = transcript.items.indexOfFirst { it.key == keep }
        if (i > 0) list.scrollToItem(i)
        paging = false
    }

    val status = transcript.status ?: record.str("status")
    val streaming = status == "working" || status == "starting"
    val agent = Speaker.reply(record.str("agent"), assistant)
    val c = V.c

    fun send() {
        val t = text.trim()
        if (t.isEmpty() || busy) return
        busy = true; note = null
        scope.launch {
            try {
                var out = app.client.call("threads.send", input("thread" to id, "text" to t, "surface" to SURFACE))
                // Another surface holds it: sending takes the lease, then sends once more.
                if (out.str("sent") == "false" && out.str("holder") != null && out.str("open_elsewhere") != "true") {
                    runCatching { app.client.call("threads.lease", input("thread" to id, "surface" to SURFACE)) }.onSuccess { holder = it.str("holder") }
                    out = app.client.call("threads.send", input("thread" to id, "text" to t, "surface" to SURFACE))
                }
                if (out.str("sent") == "true") { transcript.echo(t); version++; text = ""; holder = SURFACE }
                else note = out.str("note") ?: "Not sent: ${ChatText.holder(out.str("holder"), SURFACE) ?: "someone else"} has this session."
            } catch (e: Exception) { note = e.plain() }
            busy = false
        }
    }

    Column(Modifier.fillMaxSize().background(c.bg).statusBarsPadding().imePadding()) {
        NavBar(record.str("name") ?: label(JsonObject(mapOf("id" to JsonPrimitive(id)))), dots(agent, record.str("project")), onBack) { close ->
            DropdownMenuItem(text = { Text("Watch", style = Type.secondary, color = c.text) }, onClick = {
                close()
                scope.launch {
                    note = try {
                        app.client.call("threads.watch", input("thread" to id, "until" to "either", "notify" to SURFACE, "note" to "Watch ${record.str("name") ?: "the session"}"))
                        "Watching. You will hear when it finishes or asks."
                    } catch (e: Exception) { e.plain() }
                }
            })
            if (status in RUNNING) DropdownMenuItem(text = { Text("Stop", style = Type.secondary, color = c.text) }, onClick = {
                close()
                scope.launch { runCatching { app.client.call("threads.stop", input("thread" to id)) }.onFailure { note = it.plain() }; reload() }
            })
            DropdownMenuItem(text = { Text("Archive", style = Type.secondary, color = c.text) }, onClick = {
                close()
                setArchived(app, archivedOf(app) + id)
                toast(Toast("Archived ${record.str("name") ?: "the session"}"))
                onBack()
            })
        }
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = list, contentPadding = PaddingValues(horizontal = Space.gutter, vertical = Space.m),
            verticalArrangement = Arrangement.spacedBy(14.dp)) {
            if (error != null && lines.isEmpty()) item { Failure(error!!) }
            itemsIndexed(lines, key = { _, l -> l.key }) { i, l ->
                val bg by animateColorAsState(if (flash == l.key) c.match else Color.Transparent, tween(if (flash == l.key) 0 else 1200), label = "match")
                Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.panel)).background(bg)) {
                    if (i == 0 && paging) Text("Loading earlier", style = Type.meta, color = c.label, modifier = Modifier.fillMaxWidth().padding(bottom = Space.s), textAlign = TextAlign.Center)
                    if (i in stamps) transcript.at(l.key)?.let { Text(ChatText.stamp(it), style = Type.meta, color = c.label, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(bottom = Space.s)) }
                    LineView(l, speakerOf(l, record.str("agent"), assistant), agent, record.str("project"), caret = streaming && l is Line.Assistant && !l.done && i == lines.lastIndex)
                }
            }
            item { Spacer(Modifier.size(1.dp)) }
        }
        if (!recorded) ChatComposer(
            text, { text = it }, "Message $agent", streaming = streaming, busy = busy,
            holderLine = ChatText.holder(holder, SURFACE)?.let { "$it has this session. Sending takes it." }, note = note,
            onSend = { send() },
            onStop = { scope.launch { runCatching { app.client.call("threads.stop", input("thread" to id)) }.onFailure { note = it.plain() }; reload() } },
            onAttach = { toast(Toast("Attaching files is not in this build yet.")) },
            onFocus = { f ->
                focused = f
                if (!f && holder == SURFACE) scope.launch { runCatching { app.client.call("threads.release", input("thread" to id, "surface" to SURFACE)) }.onSuccess { holder = it.str("holder") } }
            },
        ) else Text("A recorded session: read only.", style = Type.meta, color = c.label, modifier = Modifier.fillMaxWidth().navigationBarsPadding().padding(Space.m), textAlign = TextAlign.Center)
    }
}

/**
 * The session's nav bar, 52 tall with a hairline below: "< Chats" on the left, the name centred
 * with "<agent> · <project>" under it in 12/16 --label, and a 44 more button whose menu is `menu`.
 */
@Composable
private fun NavBar(title: String, subtitle: String, onBack: () -> Unit, menu: @Composable (close: () -> Unit) -> Unit) {
    val c = V.c
    var open by remember { mutableStateOf(false) }
    Box(Modifier.fillMaxWidth().height(52.dp).padding(horizontal = 4.dp)) {
        Row(Modifier.align(Alignment.CenterStart).heightIn(min = 44.dp).clickable(role = Role.Button, onClick = onBack).padding(horizontal = 8.dp)
            .semantics { contentDescription = "Back to Chats" }, verticalAlignment = Alignment.CenterVertically) {
            Glyph.Back(c.text, 20.dp)
            Text("Chats", style = Type.input, color = c.text)
        }
        Column(Modifier.align(Alignment.Center).widthIn(max = 220.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(title, style = Type.group, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (subtitle.isNotBlank()) Text(subtitle, style = Type.micro, color = c.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Box(Modifier.align(Alignment.CenterEnd)) {
            Box(Modifier.size(44.dp).clickable(role = Role.Button, onClickLabel = "More", onClick = { open = true }).semantics { contentDescription = "More" }, contentAlignment = Alignment.Center) {
                Glyph.More(c.text, 22.dp)
            }
            DropdownMenu(open, onDismissRequest = { open = false }, containerColor = c.panel) { menu { open = false } }
        }
    }
    Hairline()
}

/**
 * The composer (phone.md section 6): --bg with a hairline above, the round attach button, the
 * input (38 tall, radius 19, --rule-strong, 17), and a 36 round button: send (arrow up on
 * --primary-bg) once there is text, stop (a square on --text) while a reply streams. One Meta
 * line above says who else holds the session.
 */
@Composable
private fun ChatComposer(value: String, onChange: (String) -> Unit, placeholder: String, streaming: Boolean, busy: Boolean, holderLine: String?, note: String?,
                         onSend: () -> Unit, onStop: () -> Unit, onAttach: () -> Unit, onFocus: (Boolean) -> Unit) {
    val c = V.c
    Column(Modifier.fillMaxWidth().background(c.bg).navigationBarsPadding()) {
        Hairline()
        holderLine?.let { Text(it, style = Type.meta, color = c.text2, modifier = Modifier.padding(start = Space.m, end = Space.m, top = Space.s)) }
        note?.let { Failure(it, Modifier.padding(start = Space.m, end = Space.m, top = Space.s)) }
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.Bottom) {
            Box(Modifier.size(36.dp).clip(CircleShape).background(c.hover).clickable(role = Role.Button, onClickLabel = "Attach", onClick = onAttach), contentAlignment = Alignment.Center) {
                Glyph.Plus(c.text, 20.dp)
            }
            Spacer(Modifier.width(Space.s))
            val shape = RoundedCornerShape(19.dp)
            Box(Modifier.weight(1f).heightIn(min = 38.dp).clip(shape).border(1.dp, c.ruleStrong, shape).padding(horizontal = 14.dp, vertical = 8.dp), contentAlignment = Alignment.CenterStart) {
                BasicTextField(value, onChange, textStyle = Type.input.copy(color = c.text), cursorBrush = SolidColor(c.focus), maxLines = 6,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                    modifier = Modifier.fillMaxWidth().onFocusChanged { onFocus(it.isFocused) }.semantics { contentDescription = placeholder },
                    decorationBox = { inner -> if (value.isEmpty()) Text(placeholder, style = Type.input, color = c.label, maxLines = 1); inner() })
            }
            Spacer(Modifier.width(Space.s))
            val canSend = value.isNotBlank() && !busy
            when {
                value.isBlank() && streaming -> Box(Modifier.size(36.dp).clip(CircleShape).background(c.text).clickable(role = Role.Button, onClickLabel = "Stop", onClick = onStop)
                    .semantics { contentDescription = "Stop" }, contentAlignment = Alignment.Center) {
                    Box(Modifier.size(11.dp).clip(RoundedCornerShape(2.dp)).background(c.bg))
                }
                else -> Box(Modifier.size(36.dp).clip(CircleShape).background(if (canSend) c.primaryBg else c.hover)
                    .clickable(enabled = canSend, role = Role.Button, onClickLabel = "Send", onClick = onSend).semantics { contentDescription = "Send" }, contentAlignment = Alignment.Center) {
                    Glyph.Send(if (canSend) c.primaryInk else c.label, 20.dp)
                }
            }
        }
    }
}

@Composable
fun LineView(l: Line, who: String?, agent: String = Speaker.FALLBACK, project: String? = null, caret: Boolean = false) {
    val c = V.c
    when (l) {
        is Line.User -> if (who == null || who == Speaker.YOU) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            YouBubble(l.text)
        } else Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
            Text(who, style = Type.meta.copy(fontWeight = FontWeight(600)), color = c.text2, modifier = Modifier.padding(bottom = 4.dp))
            YouBubble(l.text)
        }
        is Line.Assistant -> Column(Modifier.fillMaxWidth()) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 6.dp)) {
                Tile(who ?: agent, 24.dp); Spacer(Modifier.width(Space.s))
                Text(who ?: agent, style = Type.meta.copy(fontWeight = FontWeight(600)), color = c.text2)
            }
            Md(l.text, style = Type.lead, caret = caret)
        }
        is Line.Notice -> Text(l.text, style = Type.meta, color = c.label)
        is Line.Tools -> ToolBox(l)
        is Line.Ask -> if (l.question) QuestionCard(l, agent) else ApprovalCard(l, agent, project)
        is Line.Held -> HeldCard(l, agent)
        is Line.Finished -> if (l.ok) Text(listOfNotNull("Done", l.durationMs?.let { "${it / 1000} s" }, money(l.cost).takeIf { it.isNotEmpty() }).joinToString(" · "),
            style = Type.meta, color = c.label, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
            else Failure(l.error ?: "The turn did not finish.")
        is Line.Stopped -> Text("Stopped: ${l.reason}", style = Type.meta, color = c.label, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
    }
}

/** You: a bubble on the right, at most 290 wide, --hover with a --rule border, radius 18 18 6 18, 17/22. */
@Composable
private fun YouBubble(text: String) {
    val c = V.c
    val shape = RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp, bottomEnd = 6.dp, bottomStart = 18.dp)
    Text(text, style = Type.input, color = c.text, modifier = Modifier.widthIn(max = 290.dp).clip(shape).background(c.hover).border(1.dp, c.rule, shape).padding(horizontal = 14.dp, vertical = 10.dp))
}

/** "12:07". */
private fun clock(at: Long?): String = java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault()).format(java.util.Date(at ?: System.currentTimeMillis()))

/** How an answered ask reads, folded to one Meta line (phone.md section 6). */
fun answeredLine(decision: String?, scope: String?, project: String?, at: Long?, question: Boolean = false): String = when {
    decision == "always" && scope == "project" -> "Always allowed in ${project ?: "this project"}, ${clock(at)}"
    decision == "always" -> "Always allowed, ${clock(at)}"
    question && decision == "allow" -> "Answered by you, ${clock(at)}"
    question && decision == "deny" -> "Declined by you, ${clock(at)}"
    decision == "allow" -> "Approved by you, ${clock(at)}"
    decision == "deny" -> "Denied by you, ${clock(at)}"
    decision == "cancelled" -> "Withdrawn, ${clock(at)}"
    else -> "Answered, ${clock(at)}"
}

private fun hapticFor(view: android.view.View, yes: Boolean) {
    view.performHapticFeedback(if (Build.VERSION.SDK_INT >= 30) (if (yes) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.REJECT) else HapticFeedbackConstants.LONG_PRESS)
}

/** The card's top line: the attention dot, "<agent> is waiting on you", and Details (the detail sheet). */
@Composable
private fun CardHead(agent: String, id: String) {
    val nav = LocalNav.current
    val c = V.c
    Row(verticalAlignment = Alignment.CenterVertically) {
        Dot(c.beaconDot, 7.dp); Spacer(Modifier.width(Space.s))
        Text("$agent is waiting on you", style = Type.meta.copy(fontWeight = FontWeight(600)), color = c.beaconInk, modifier = Modifier.weight(1f))
        Box(Modifier.heightIn(min = 44.dp).clickable(role = Role.Button, onClick = { nav("needs/$id") }).padding(start = Space.m), contentAlignment = Alignment.Center) {
            Text("Details", style = Type.meta.copy(fontWeight = FontWeight(600)), color = c.text)
        }
    }
}

/** The neutral card around an ask or a question: --panel, --rule-strong, no wash, radius 12, 14 padding, 10 between parts. */
@Composable
private fun AskFrame(content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) {
    val c = V.c
    val shape = RoundedCornerShape(12.dp)
    Column(Modifier.fillMaxWidth().clip(shape).background(c.panel).border(1.dp, c.ruleStrong, shape).padding(14.dp), verticalArrangement = Arrangement.spacedBy(10.dp), content = content)
}

/**
 * An ask in this session (phone.md section 6): the card's head, the command in a mono block, one
 * Meta line of facts, then Deny and Approve (the fingerprint glyph only when the box says one is
 * needed). Answered, here or anywhere, it folds to "Approved by you, 12:07".
 */
@Composable
fun ApprovalCard(l: Line.Ask, agent: String, project: String?) {
    val app = LocalApp.current
    val view = LocalView.current
    val c = V.c
    var busy by remember(l.ask) { mutableStateOf(false) }
    var failure by remember(l.ask) { mutableStateOf<String?>(null) }
    if (l.decision != null && l.decision != "null") { Text(answeredLine(l.decision, l.scope, project, l.decidedAt), style = Type.meta, color = c.label); return }
    val glyph = Gate.glyph(l.raw)
    fun answer(decision: String) {
        if (busy) return
        busy = true; failure = null
        app.scope.launch(Dispatchers.Main) {
            try {
                val out = app.client.callOrProve("threads.answer", answerInput(l.ask, decision, SURFACE), (if (decision == "allow") "Approve: " else "Deny: ") + l.summary,
                    required = Gate.required(l.raw), session = true)
                if (out.str("answered") == "false") failure = out.str("note") ?: "It was already answered." else hapticFor(view, decision == "allow")
            } catch (e: ApiError.Cancelled) { } catch (e: Exception) { failure = e.plain() }
            busy = false
        }
    }
    AskFrame {
        CardHead(agent, l.ask)
        CommandBlock(AskView.command(l.raw).ifEmpty { l.summary }, radius = 6.dp)
        listOfNotNull(AskView.changes(l.raw)?.line, l.destination?.takeIf { it != l.summary }?.let(ChatText::short), project).takeIf { it.isNotEmpty() }
            ?.let { Text(it.joinToString(" · "), style = Type.meta, color = c.text2) }
        failure?.let { Failure(it) }
        Row(horizontalArrangement = Arrangement.spacedBy(Space.s)) {
            VButton("Deny", onClick = { answer("deny") }, enabled = !busy, modifier = Modifier.weight(1f))
            VButton("Approve", onClick = { answer("allow") }, kind = ButtonKind.Primary, enabled = !busy, modifier = Modifier.weight(1f),
                icon = (sh.vyre.app.ui.FingerprintIcon).takeIf { glyph })
        }
    }
}

/** A question in this session: the same card, its choices as rows inside, Later and Answer. */
@Composable
fun QuestionCard(l: Line.Ask, agent: String) {
    val app = LocalApp.current
    val view = LocalView.current
    val c = V.c
    if (l.decision != null && l.decision != "null") { Text(answeredLine(l.decision, l.scope, null, l.decidedAt, question = true), style = Type.meta, color = c.label); return }
    val qs = remember(l.raw) { Questions.of(l.raw) }
    val picks = remember(l.ask, qs.size) { mutableStateListOf<Pick>().apply { repeat(qs.size) { add(Pick()) } } }
    var busy by remember(l.ask) { mutableStateOf(false) }
    var failure by remember(l.ask) { mutableStateOf<String?>(null) }
    val answers = Questions.answers(qs, picks)
    fun send(decision: String) {
        if (busy) return
        val a = answers
        if (decision == "allow" && a == null) return
        busy = true; failure = null
        app.scope.launch(Dispatchers.Main) {
            try {
                val body = if (a != null && decision == "allow") answerInput(l.ask, "allow", SURFACE, answers = a) else answerInput(l.ask, "deny", SURFACE)
                val out = app.client.callOrProve("threads.answer", body, if (a != null && decision == "allow") "Answer: " + a.values.joinToString("; ") else "Decline the question",
                    required = Gate.required(l.raw), session = true)
                if (out.str("answered") == "false") failure = out.str("note") ?: "It was already answered." else hapticFor(view, decision == "allow")
            } catch (e: ApiError.Cancelled) { } catch (e: Exception) { failure = e.plain() }
            busy = false
        }
    }
    AskFrame {
        CardHead(agent, l.ask)
        if (qs.isEmpty()) Text(l.summary, style = Type.lead, color = c.text)
        qs.forEachIndexed { i, q -> QuestionBlock(q, picks[i], enabled = !busy) { picks[i] = it } }
        failure?.let { Failure(it) }
        Row(horizontalArrangement = Arrangement.spacedBy(Space.s)) {
            VButton("Later", onClick = { send("deny") }, enabled = !busy, modifier = Modifier.weight(1f))
            VButton("Answer", onClick = { send("allow") }, kind = ButtonKind.Primary, enabled = !busy && answers != null, modifier = Modifier.weight(1f))
        }
    }
}

/** A draft this session held at the Gate: the same neutral card; its words and Send are in the detail sheet. */
@Composable
fun HeldCard(l: Line.Held, agent: String) {
    val nav = LocalNav.current
    val c = V.c
    if (l.state != "held") { Text(if (l.state == "sent") "Sent after you approved it." else "Discarded.", style = Type.meta, color = c.label); return }
    val shape = RoundedCornerShape(12.dp)
    Row(Modifier.fillMaxWidth().clip(shape).background(c.panel).border(1.dp, c.ruleStrong, shape).clickable(role = Role.Button) { nav("needs/${l.id}") }.padding(14.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Dot(c.beaconDot, 7.dp); Spacer(Modifier.width(Space.s))
        Text("$agent held a draft for you", style = Type.meta.copy(fontWeight = FontWeight(600)), color = c.beaconInk, modifier = Modifier.weight(1f))
        Text("Details", style = Type.meta.copy(fontWeight = FontWeight(600)), color = c.text)
    }
}

/**
 * Tool rows, grouped in one box (--rule border, radius 10, hairlines between): a check once done,
 * a spinner while running, the crossed circle and "failed" when it failed; the action and target
 * in mono 13/18. Tap expands a row in place to the whole command and where it went (the box
 * sends no tool output). Calls that read memory or recall show as a From memory block instead.
 */
@Composable
fun ToolBox(l: Line.Tools) {
    val c = V.c
    val (recall, tools) = l.calls.partition { ChatText.memory(it.tool) }
    Column(verticalArrangement = Arrangement.spacedBy(Space.s)) {
        if (recall.isNotEmpty()) Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.panel)).background(c.recallWash).padding(horizontal = 14.dp, vertical = 12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Glyph.History(c.recall, 14.dp); Spacer(Modifier.width(6.dp))
                Text("From memory", style = Type.meta.copy(fontWeight = FontWeight(600)), color = c.recall)
            }
            for (r in recall) Text(r.summary.substringAfter(": ", r.summary), style = Type.secondary, color = c.text, modifier = Modifier.padding(top = 6.dp))
        }
        if (tools.isNotEmpty()) {
            val shape = RoundedCornerShape(Radius.panel)
            Column(Modifier.fillMaxWidth().clip(shape).border(1.dp, c.rule, shape)) {
                tools.forEachIndexed { i, t -> if (i > 0) Hairline(); ToolRow(t) }
            }
        }
    }
}

@Composable
private fun ToolRow(t: ToolCall) {
    val c = V.c
    var open by remember(t.id) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().animateContentSize(tween(180)).clickable(role = Role.Button, onClickLabel = if (open) "Fold" else "Show the whole command") { open = !open }
        .padding(horizontal = 12.dp, vertical = 9.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            when {
                t.error -> Glyph.Failed(c.text, 16.dp)
                t.done -> Glyph.Check(c.label, 16.dp)
                else -> CircularProgressIndicator(Modifier.size(14.dp), color = c.label, strokeWidth = 1.5.dp)
            }
            Spacer(Modifier.width(Space.s))
            Text(ChatText.phrase(t), style = Type.logRow, color = c.text, maxLines = if (open) 6 else 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            if (t.error) { Spacer(Modifier.width(Space.s)); Text("failed", style = Type.meta, color = c.label) }
        }
        if (open) Column(Modifier.padding(start = 24.dp, top = 6.dp)) {
            Text(t.summary, style = Type.log, color = c.text2)
            t.destination?.takeIf { it != t.summary }?.let { Text(it, style = Type.log, color = c.label) }
            Text(t.tool, style = Type.log, color = c.label)
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
        Column(Modifier.size(44.dp).clip(RoundedCornerShape(Radius.button)).background(if (can) c.primaryBg else c.hover)
            .clickable(enabled = can, role = Role.Button, onClickLabel = "Send", onClick = onSend), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            Icon(Icons.AutoMirrored.Filled.ArrowForward, "Send", tint = if (can) c.primaryInk else c.label, modifier = Modifier.size(20.dp))
        }
    }
}
