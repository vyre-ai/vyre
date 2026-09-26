package sh.vyre.app.ui

import android.os.Build
import android.view.HapticFeedbackConstants
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import sh.vyre.app.api.ApiError
import sh.vyre.app.api.arr
import sh.vyre.app.api.at
import sh.vyre.app.api.input
import sh.vyre.app.api.long
import sh.vyre.app.api.plain
import sh.vyre.app.api.str
import sh.vyre.app.data.Need
import sh.vyre.app.data.Needs
import sh.vyre.app.data.ago
import sh.vyre.app.design.ButtonKind
import sh.vyre.app.design.Glyph
import sh.vyre.app.design.Label
import sh.vyre.app.design.Radius
import sh.vyre.app.design.Space
import sh.vyre.app.design.Type
import sh.vyre.app.design.V
import sh.vyre.app.design.VButton
import kotlin.math.abs
import kotlin.math.roundToInt

/** What Now shows: held items, open asks, sessions, agents, what memory learned today. */
data class NowData(val held: List<JsonElement>, val asks: List<JsonElement>, val threads: List<JsonElement>, val agents: List<JsonElement>, val learned: List<JsonElement>, val note: String?)

suspend fun loadNow(app: sh.vyre.app.VyreApp): NowData = coroutineScope {
    val held = async { runCatching { app.client.call("gate.held").arr.toList() } }
    val asks = async { runCatching { app.client.call("threads.asks").arr.toList() } }
    val threads = async { runCatching { app.client.call("threads.list", input("all" to true)).arr.toList() } }
    val agents = async { runCatching { app.client.call("agents.list").arr.toList() } }
    val facts = async { runCatching { app.client.call("memory.facts", input("limit" to 20)).at("facts").arr.toList() } }
    val h = held.await(); val a = asks.await(); val t = threads.await(); val g = agents.await(); val f = facts.await()
    // All the needs reads failing is a failure; one refusing (an old box without the tailnet callers entry) is a note.
    val errs = listOf(h, a, t, g).mapNotNull { it.exceptionOrNull() }
    if (errs.size == 4) throw errs.first()
    val note = errs.firstOrNull { it is ApiError.Denied }?.let { "Some of this box refuses the phone: ${it.message}" }
    NowData(h.getOrDefault(emptyList()), a.getOrDefault(emptyList()), t.getOrDefault(emptyList()), g.getOrDefault(emptyList()),
        today(f.getOrDefault(emptyList())), note)
}

/** Facts memory learned in the last day, newest first (a fact's `since` is when it started to hold). */
private fun today(facts: List<JsonElement>, now: Long = System.currentTimeMillis()): List<JsonElement> =
    facts.filter { f -> (f.long("since") ?: 0L).let { it > now - 86_400_000L && it <= now + 60_000L } }.sortedByDescending { it.long("since") ?: 0L }

private fun haptic(view: android.view.View, kind: String) {
    val c = when (kind) {
        "confirm" -> if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.LONG_PRESS
        "reject" -> if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS
        else -> HapticFeedbackConstants.CLOCK_TICK
    }
    view.performHapticFeedback(c)
}

/**
 * Now (phone.md section 4): the one-row setup reminder, "Needs you" (a card of rows you swipe:
 * right approves or sends with the fingerprint, left denies or discards with Undo for 4 s; a tap
 * opens the item), "Working", and "From memory". Sections with nothing in them are left out.
 * Everything comes from events; the fallback read is every 60 s while Now is on screen.
 */
@Composable
fun NowScreen() {
    val app = LocalApp.current
    val nav = LocalNav.current
    val toast = LocalToast.current
    val onScreen = LocalOnScreen.current
    val view = LocalView.current
    val lifecycle = LocalLifecycleOwner.current
    val load = rememberLoad("now") { loadNow(app) }
    OnEvents("ask.raised", "ask.answered", "gate.held", "gate.released", "gate.failed", "gate.rejected", "thread.started", "thread.finished", "thread.stopped", "memory.curated") { load.refresh() }
    LaunchedEffect(onScreen) {
        if (!onScreen) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) { while (true) { delay(60_000); load.refresh() } }
    }
    // The latest step of each running session, from thread.tool (the list has no step).
    val steps = remember { mutableStateMapOf<String, Pair<String, Int>>() }
    OnEvents("thread.tool") { e ->
        val t = e.str("thread") ?: return@OnEvents
        if (e.str("phase") == "started") steps[t] = (e.str("summary") ?: e.str("tool").orEmpty()) to ((steps[t]?.second ?: 0) + 1)
    }
    val d = load.v.value
    val agentOf = d?.threads?.associate { it.str("id") to it.str("agent") }.orEmpty()
    val projectOf = d?.threads?.associate { it.str("id") to it.str("project") }.orEmpty()
    val rows = remember(d) { if (d == null) emptyList() else Needs.rows(d.held, d.asks, { agentOf[it] }, { projectOf[it] }) }

    // Swipe state: rows collapsed (answered or waiting out Undo), a failure per row, and a reset
    // signal per row that springs it back.
    val hidden = remember { mutableStateMapOf<String, Boolean>() }
    val failed = remember { mutableStateMapOf<String, String>() }
    val resets = remember { mutableStateMapOf<String, Int>() }
    var busy by remember { mutableStateOf<String?>(null) }
    fun reset(id: String) { resets[id] = (resets[id] ?: 0) + 1 }
    val decide = rememberDecider { load.refresh() }
    ConfirmDialog(decide)
    val prefs = remember { app.getSharedPreferences("shell", android.content.Context.MODE_PRIVATE) }
    var swiped by remember { mutableStateOf(prefs.getBoolean("swiped", false)) }
    fun swipedOnce() { if (!swiped) { swiped = true; prefs.edit().putBoolean("swiped", true).apply() } }

    // A new item while Now is on screen: REJECT once (phone.md section 10).
    var seen by remember { mutableStateOf<Set<String>?>(null) }
    LaunchedEffect(rows.map { it.id }.toSet()) {
        val ids = rows.map { it.id }.toSet()
        val before = seen
        if (before != null && onScreen && (ids - before).isNotEmpty()) haptic(view, "reject")
        if (d != null) seen = ids
    }

    fun yes(n: Need) {
        swipedOnce(); failed.remove(n.id)
        when (n.kind) {
            // Floor rule 1: a draft shows its final words before the proof (Decider).
            Need.Kind.Draft -> { reset(n.id); decide.approve(n.id) }
            Need.Kind.Ask -> {
                busy = n.id
                app.scope.launch(Dispatchers.Main) {
                    try {
                        val out = app.client.callProved("threads.answer", input("ask" to n.id, "decision" to "allow", "surface" to SURFACE), "Approve: " + n.line)
                        if (out.str("answered") == "false") { failed[n.id] = out.str("note") ?: "Already answered."; reset(n.id) }
                        else { haptic(view, "confirm"); hidden[n.id] = true; delay(200); load.refresh() }
                    } catch (e: ApiError.Cancelled) { reset(n.id) } catch (e: Exception) { failed[n.id] = e.plain(); reset(n.id) }
                    busy = null
                }
            }
        }
    }

    /** Deny or discard: the proof now, the row gone at once, the answer sent after 4 s unless undone. */
    fun no(n: Need) {
        swipedOnce(); failed.remove(n.id)
        val (tool, body) = if (n.kind == Need.Kind.Draft) "gate.reject" to input("id" to n.id)
            else "threads.answer" to input("ask" to n.id, "decision" to "deny", "surface" to SURFACE)
        app.scope.launch(Dispatchers.Main) {
            val prover = app.client.prover ?: run { failed[n.id] = "This phone has no device key yet."; reset(n.id); return@launch }
            val header = try { prover.header(tool, body, "${n.no}: ${n.title}") }
                catch (e: ApiError.Cancelled) { reset(n.id); return@launch } catch (e: Exception) { failed[n.id] = e.plain(); reset(n.id); return@launch }
            haptic(view, "reject")
            hidden[n.id] = true
            var undone = false
            toast(Toast("${if (n.kind == Need.Kind.Draft) "Discarded" else "Denied"}: ${n.title}", "Undo", 4000, onAction = { undone = true; hidden.remove(n.id); reset(n.id) }))
            delay(4000)
            if (undone) return@launch
            try { app.client.call(tool, body, header); load.refresh() }
            catch (e: Exception) { hidden.remove(n.id); failed[n.id] = e.plain(); reset(n.id) }
        }
    }

    val c = V.c
    val visible = rows.filter { hidden[it.id] != true }
    Page {
        // Setup: anything missing is one row at the top (phone.md section 4).
        setupRow(app)?.let { (text, route) -> item { SetupRow(text) { nav(route) } } }
        d?.note?.let { item { Quiet(it) } }
        if (d == null && load.v.loading) { item { Skeleton() }; return@Page }
        if (d == null) { loadState(load.v, false, ""); return@Page }

        item { NowSection("Needs you", visible.size, beacon = visible.isNotEmpty()) }
        if (visible.isEmpty()) item { Text("Nothing needs you.", style = Type.secondary, color = c.label) }
        else {
            item {
                Card {
                    rows.forEachIndexed { i, n ->
                        AnimatedVisibility(hidden[n.id] != true, exit = shrinkVertically(tween(180)) + fadeOut(tween(180))) {
                            Column {
                                if (i > 0 && rows.take(i).any { hidden[it.id] != true }) HairlineIn()
                                NeedRow(n, failed[n.id], busy == n.id, resets[n.id] ?: 0,
                                    onYes = { yes(n) }, onNo = { no(n) }, onOpen = { nav("needs/${n.id}") }, onCross = { haptic(view, "confirm") })
                            }
                        }
                    }
                }
            }
            if (!swiped) item { Text("Swipe right to approve with fingerprint, left to deny.", style = Type.meta, color = c.label, modifier = Modifier.padding(top = Space.s)) }
            item { DecideNote(decide) }
        }

        working(d, steps, nav)
        remembered(d, nav)
    }
}

/** The one row at the top when this phone is missing something, and where it leads. */
private fun setupRow(app: sh.vyre.app.VyreApp): Pair<String, String>? {
    app.key.canAuthenticate()?.let { return "Add a fingerprint to approve from this phone" to "settings" }
    if (sh.vyre.app.push.FcmToken.AVAILABLE && sh.vyre.app.push.PushRegistration.device(app) == null) return "Turn on notifications for this phone" to "settings"
    return null
}

@Composable
private fun SetupRow(text: String, onClick: () -> Unit) {
    val c = V.c
    Row(Modifier.fillMaxWidth().padding(top = Space.s).clip(RoundedCornerShape(Radius.panel)).background(c.panel).border(1.dp, c.rule, RoundedCornerShape(Radius.panel))
        .clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text, style = Type.secondary, color = c.text, modifier = Modifier.weight(1f))
        Glyph.Chevron(c.label)
    }
}

/** A section header: sentence case, Section type, the count on the right; 24 above, 8 below. */
@Composable
private fun NowSection(title: String, count: Int?, beacon: Boolean = false) {
    val c = V.c
    Row(Modifier.fillMaxWidth().padding(top = Space.xl, bottom = Space.s), verticalAlignment = Alignment.CenterVertically) {
        if (beacon) { Box(Modifier.size(8.dp).clip(CircleShape).background(c.beaconDot)); Spacer(Modifier.width(Space.s)) }
        Text(title, style = Type.section, color = c.text, modifier = Modifier.weight(1f))
        if (count != null && count > 0) Text("$count", style = Type.secondary, color = c.label)
    }
}

/** A card: --panel, a --rule border, radius 10. Rows inside draw their own hairlines. */
@Composable
private fun Card(content: @Composable () -> Unit) {
    val c = V.c
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.panel)).background(c.panel).border(1.dp, c.rule, RoundedCornerShape(Radius.panel))) { content() }
}

@Composable
private fun HairlineIn() { Box(Modifier.fillMaxWidth().height(1.dp).background(V.c.rule)) }

/** The first load only: the real card shapes in --hover, no shimmer. */
@Composable
private fun Skeleton() {
    val c = V.c
    Column(verticalArrangement = Arrangement.spacedBy(Space.s), modifier = Modifier.padding(top = Space.xl)) {
        Box(Modifier.width(120.dp).height(22.dp).clip(RoundedCornerShape(4.dp)).background(c.hover))
        Box(Modifier.fillMaxWidth().height(170.dp).clip(RoundedCornerShape(Radius.panel)).background(c.hover))
        Box(Modifier.width(100.dp).height(22.dp).padding(top = Space.l).clip(RoundedCornerShape(4.dp)).background(c.hover))
        Box(Modifier.fillMaxWidth().height(110.dp).clip(RoundedCornerShape(Radius.panel)).background(c.hover))
    }
}

/**
 * One Needs row with its swipe (phone.md section 4). The row follows the finger; right reveals
 * the primary action (100 wide, --primary-bg), left reveals Deny or Discard (--hover). Past 100
 * or a fast fling it commits; short of 100 the action stays showing and a tap on it commits.
 * Every swipe action is also an accessibility action, with Open.
 */
@Composable
private fun NeedRow(n: Need, failed: String?, busy: Boolean, reset: Int, onYes: () -> Unit, onNo: () -> Unit, onOpen: () -> Unit, onCross: () -> Unit) {
    val c = V.c
    val scope = rememberCoroutineScope()
    val max = with(LocalDensity.current) { 100.dp.toPx() }
    val offset = remember(n.id) { Animatable(0f) }
    var crossed by remember { mutableStateOf(false) }
    LaunchedEffect(reset) { offset.animateTo(0f, spring(dampingRatio = 1f, stiffness = 400f)) }
    fun commitRight() { scope.launch { offset.animateTo(max, tween(120)) }; onYes() }
    fun commitLeft() { scope.launch { offset.animateTo(-max, tween(120)) }; onNo() }
    val density = LocalDensity.current

    Box(
        Modifier.fillMaxWidth().height(IntrinsicSize.Min)
            .semantics {
                contentDescription = Needs.label(n)
                customActions = listOf(
                    CustomAccessibilityAction(n.yes) { onYes(); true },
                    CustomAccessibilityAction(n.no) { onNo(); true },
                    CustomAccessibilityAction("Open") { onOpen(); true },
                )
            }
            .pointerInput(n.id, busy) {
                if (busy) return@pointerInput
                val vt = VelocityTracker()
                detectHorizontalDragGestures(
                    onDragStart = { vt.resetTracking(); crossed = abs(offset.value) >= max },
                    onDragCancel = { scope.launch { offset.animateTo(0f, spring(dampingRatio = 1f)) } },
                    onDragEnd = {
                        val v = vt.calculateVelocity().x
                        val x = offset.value
                        when {
                            x >= max || (v > 1500f && x > 0f) -> commitRight()
                            x <= -max || (v < -1500f && x < 0f) -> commitLeft()
                            x > max * 0.4f -> scope.launch { offset.animateTo(max, spring(dampingRatio = 1f)) }
                            x < -max * 0.4f -> scope.launch { offset.animateTo(-max, spring(dampingRatio = 1f)) }
                            else -> scope.launch { offset.animateTo(0f, spring(dampingRatio = 1f)) }
                        }
                    },
                ) { change, dx ->
                    vt.addPosition(change.uptimeMillis, change.position)
                    change.consume()
                    val next = (offset.value + dx).coerceIn(-max * 1.6f, max * 1.6f)
                    scope.launch { offset.snapTo(next) }
                    val over = abs(next) >= max
                    if (over != crossed) { crossed = over; if (over) onCross() }
                }
            },
    ) {
        val x = offset.value
        if (x > 0f) Box(
            Modifier.align(Alignment.CenterStart).fillMaxHeight().width(with(density) { x.toDp() }).background(c.primaryBg)
                .clickable(enabled = !busy, onClick = { commitRight() }),
            contentAlignment = Alignment.Center,
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Glyph.Fingerprint(c.primaryInk, 24.dp)
                Text(if (busy) "Checking" else n.yes, style = Type.meta.copy(fontWeight = FontWeight(600)), color = c.primaryInk, maxLines = 1)
            }
        }
        if (x < 0f) Box(
            Modifier.align(Alignment.CenterEnd).fillMaxHeight().width(with(density) { (-x).toDp() }).background(c.hover)
                .clickable(onClick = { commitLeft() }),
            contentAlignment = Alignment.Center,
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Glyph.Close(c.text, 20.dp)
                Text(n.no, style = Type.meta.copy(fontWeight = FontWeight(600)), color = c.text, maxLines = 1)
            }
        }
        Row(
            Modifier.offset { IntOffset(x.roundToInt(), 0) }.fillMaxWidth().background(c.panel).clickable(onClick = onOpen)
                .padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Box(Modifier.size(32.dp).clip(RoundedCornerShape(Radius.tile)).background(c.hover).border(1.dp, c.ruleStrong, RoundedCornerShape(Radius.tile)), contentAlignment = Alignment.Center) {
                Text(n.initial, style = Type.secondary.copy(fontWeight = FontWeight(600)), color = c.text)
            }
            Spacer(Modifier.width(Space.m))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(n.title, style = Type.rowTitle, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                    Text(Needs.short(n.at), style = Type.meta, color = c.label, modifier = Modifier.padding(start = Space.s))
                }
                if (n.line.isNotBlank()) Text(n.line, style = if (n.kind == Need.Kind.Ask) Type.commandRow else Type.secondary, color = c.text2,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
                Text(dots(n.agent, n.project), style = Type.meta, color = c.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
                if (failed != null) Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("failed", style = Type.meta, color = c.label)
                    Spacer(Modifier.width(Space.s))
                    Text(failed, style = Type.meta, color = c.text)
                }
            }
            Spacer(Modifier.width(Space.s))
            Glyph.Chevron(c.label, modifier = Modifier.padding(top = 3.dp))
        }
    }
}

/**
 * Working (phone.md section 4): a card, a row per running session: the agent's tile, the session
 * name, its latest step, the step count. A finished one reads "Done" and leaves after an hour.
 * When nothing is running, the two most recent sessions stand in.
 */
private fun LazyListScope.working(d: NowData, steps: Map<String, Pair<String, Int>>, nav: (String) -> Unit) {
    val now = System.currentTimeMillis()
    val running = d.threads.filter { it.str("status") in setOf("working", "starting", "waiting") }
    val done = d.threads.filter { it.str("status") !in setOf("working", "starting", "waiting") && (it.str("last")?.toLongOrNull() ?: 0) > now - 3_600_000 }
    val shown = (running + done).ifEmpty { d.threads.sortedByDescending { it.str("last")?.toLongOrNull() ?: 0 }.take(2) }
    if (shown.isEmpty()) return
    item { NowSection("Working", running.size) }
    item {
        Card {
            shown.forEachIndexed { i, t ->
                if (i > 0) HairlineIn()
                WorkingRow(t, t.str("status") in setOf("working", "starting", "waiting"), steps[t.str("id")]) { t.str("id")?.let { nav("thread/$it") } }
            }
        }
    }
}

@Composable
private fun WorkingRow(t: JsonElement, live: Boolean, step: Pair<String, Int>?, onClick: () -> Unit) {
    val c = V.c
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.Top) {
        Box(Modifier.size(32.dp).clip(RoundedCornerShape(Radius.tile)).background(c.hover).border(1.dp, c.ruleStrong, RoundedCornerShape(Radius.tile)), contentAlignment = Alignment.Center) {
            Text((t.str("agent") ?: "V").take(1).uppercase(), style = Type.secondary.copy(fontWeight = FontWeight(600)), color = c.text)
        }
        Spacer(Modifier.width(Space.m))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(label(t), style = Type.rowTitle, color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                val right = when {
                    !live -> "Done"
                    t.str("status") == "waiting" -> "Waiting on you"
                    step != null -> "${step.second} step${if (step.second == 1) "" else "s"}"
                    else -> ago(t.str("started")?.toLongOrNull())
                }
                Text(right, style = Type.meta, color = if (live && t.str("status") == "waiting") c.beaconInk else c.label, modifier = Modifier.padding(start = Space.s))
            }
            val latest = step?.first ?: dots(t.str("agent"), t.str("project"))
            if (latest.isNotBlank()) Text(latest, style = Type.secondary, color = c.text2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
        }
    }
}

/** From memory (phone.md section 4): what memory learned today, on --recall-wash. */
private fun LazyListScope.remembered(d: NowData, nav: (String) -> Unit) {
    val f = d.learned.firstOrNull() ?: return
    item {
        val c = V.c
        Column(Modifier.fillMaxWidth().padding(top = Space.xl).clip(RoundedCornerShape(Radius.panel)).background(c.recallWash)
            .clickable { f.str("id")?.let { nav("fact/" + android.net.Uri.encode(it)) } }.padding(horizontal = 14.dp, vertical = 12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Glyph.History(c.recall, 14.dp)
                Spacer(Modifier.width(6.dp))
                Text("From memory", style = Type.meta.copy(fontWeight = FontWeight(600)), color = c.recall)
            }
            Text(f.str("text").orEmpty(), style = Type.secondary.copy(lineHeight = androidx.compose.ui.unit.TextUnit(21f, androidx.compose.ui.unit.TextUnitType.Sp)), color = c.text, modifier = Modifier.padding(top = 6.dp))
            val more = d.learned.size - 1
            if (more > 0) Text("And $more more today", style = Type.meta, color = c.label, modifier = Modifier.padding(top = 4.dp))
        }
    }
}

/** needs/<id>: a held item or an ask, whole (a push lands here too). */
@Composable
fun NeedsScreen(id: String, onBack: () -> Unit) {
    val app = LocalApp.current
    val load = rememberLoad(id) {
        val asks = runCatching { app.client.call("threads.asks").arr.toList() }.getOrDefault(emptyList())
        asks.firstOrNull { it.str("id") == id }
    }
    // The held item's brief, for its thread (gate.held carries it; the item view reads gate.get itself).
    val brief = rememberLoad("brief", id) { runCatching { app.client.call("gate.held").arr.firstOrNull { it.str("id") == id } }.getOrNull() }
    val go = LocalGo.current
    Page(top = { BackBar("Now", onBack) { androidx.compose.foundation.layout.Row(verticalAlignment = Alignment.CenterVertically) { sh.vyre.app.design.Dot(V.c.beaconDot); androidx.compose.foundation.layout.Spacer(Modifier.padding(horizontal = 4.dp)); Label("Needs you", color = V.c.beaconInk) } } }) {
        item {
            val ask = load.v.value
            when {
                load.v.loading && ask == null -> Quiet("Loading")
                ask != null -> AskItem(ask, null, onDone = onBack)
                else -> HeldItem(id, onDone = { onBack() })
            }
            // Into the exact Chat session this came from: the Chat tab, that thread on top of its list.
            val thread = ask?.str("thread") ?: brief.v.value?.str("thread")
            sh.vyre.app.data.Links.session(thread)?.let { route ->
                VButton("Open session", onClick = { go(route) }, kind = ButtonKind.Quiet, modifier = Modifier.padding(top = Space.m))
            }
        }
    }
}
