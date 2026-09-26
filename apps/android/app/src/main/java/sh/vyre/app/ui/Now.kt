package sh.vyre.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import sh.vyre.app.api.ApiError
import sh.vyre.app.api.arr
import sh.vyre.app.api.at
import sh.vyre.app.api.input
import sh.vyre.app.api.plain
import sh.vyre.app.api.str
import sh.vyre.app.data.Held
import sh.vyre.app.data.ago
import sh.vyre.app.design.Label
import sh.vyre.app.design.SectionHead
import sh.vyre.app.design.Space
import sh.vyre.app.design.Type
import sh.vyre.app.design.V
import sh.vyre.app.design.VButton
import sh.vyre.app.design.ButtonKind

/** What Now shows: held items, open asks, running sessions, the assistant. */
data class NowData(val held: List<JsonElement>, val asks: List<JsonElement>, val threads: List<JsonElement>, val agents: List<JsonElement>, val note: String?)

private val WORDS = listOf("Nothing", "One thing", "Two things", "Three things", "Four things", "Five things", "Six things", "Seven things", "Eight things", "Nine things")
fun needsLine(n: Int) = if (n == 0) "Nothing needs you." else (WORDS.getOrNull(n) ?: "$n things") + (if (n == 1) " needs you." else " need you.")

suspend fun loadNow(app: sh.vyre.app.VyreApp): NowData = coroutineScope {
    val held = async { runCatching { app.client.call("gate.held").arr.toList() } }
    val asks = async { runCatching { app.client.call("threads.asks").arr.toList() } }
    val threads = async { runCatching { app.client.call("threads.list").arr.toList() } }
    val agents = async { runCatching { app.client.call("agents.list").arr.toList() } }
    val h = held.await(); val a = asks.await(); val t = threads.await(); val g = agents.await()
    // All four failing is a failure; one refusing (an old box without the tailnet callers entry) is a note.
    val errs = listOf(h, a, t, g).mapNotNull { it.exceptionOrNull() }
    if (errs.size == 4) throw errs.first()
    val note = errs.firstOrNull { it is ApiError.Denied }?.let { "Some of this box refuses the phone: ${it.message}" }
    NowData(h.getOrDefault(emptyList()), a.getOrDefault(emptyList()), t.getOrDefault(emptyList()), g.getOrDefault(emptyList()), note)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NowScreen() {
    val app = LocalApp.current
    val nav = LocalNav.current
    val scope = rememberCoroutineScope()
    val load = rememberLoad("now") { loadNow(app) }
    OnEvents("ask.raised", "ask.answered", "gate.held", "gate.released", "gate.failed", "gate.rejected", "thread.started", "thread.finished", "thread.stopped") { load.refresh() }
    val offline by app.client.offline.collectAsState()
    val d = load.v.value
    val address by app.prefs.address.collectAsState()
    val host = address?.substringAfter("://")?.trimEnd('/')
    // The owner's name for the avatar (system.info, owner.name); a box without it gives the host's letter.
    val owner = rememberLoad("owner") { runCatching { app.client.call("system.info").at("owner").str("name") }.getOrNull() }
    val agentOf = d?.threads?.associate { it.str("id") to it.str("agent") }.orEmpty()
    val working = d?.threads?.filter { it.str("status") in setOf("working", "starting", "waiting") }.orEmpty()
    val needs = (d?.held?.size ?: 0) + (d?.asks?.size ?: 0)
    // Swipes decide (Direction B): right approves or allows, left discards or denies, each through
    // the device proof; a send first shows its final words (Decider, floor rule 1).
    val decide = rememberDecider { load.refresh() }
    ConfirmDialog(decide)

    Page {
        item {
            Text(if (d == null) " " else needsLine(needs), style = Type.h1, color = V.c.text, modifier = Modifier.padding(top = Space.s))
            val assistant = d?.agents?.firstOrNull { it.str("kind") == "assistant" }
            if (assistant != null) Text(buildAnnotatedString {
                withStyle(SpanStyle(color = V.c.label)) { append(sh.vyre.app.data.Speaker.assistant(d.agents) + " · ") }
                append(assistant.str("doing").orEmpty())
            }, style = Type.monoSmall, color = V.c.text2, modifier = Modifier.padding(top = 4.dp))
            if (offline) Quiet("Showing what this phone kept. Can't reach the box.", "offline")
            d?.note?.let { Quiet(it) }
            DecideNote(decide)
        }
        loadState(load.v, empty = false, emptyText = "")
        if (d != null && needs > 0) {
            item { SectionHead("Needs you · $needs", color = V.c.beaconInk) }
            items(d.held, key = { "h" + it.str("id") }) { h ->
                val id = h.str("id") ?: return@items
                Swipe(onRight = { decide.approve(id) }, rightLabel = Held.action(h.str("kind")), onLeft = { decide.reject(h) }, leftLabel = "Discard") {
                    NeedCard("Held at the Gate", listOfNotNull(h.str("agent"), ago(h.str("at")?.toLongOrNull())).joinToString(" · "),
                        title = { Text(Held.title(h), style = Type.bodyStrong, color = V.c.text) },
                        sub = listOfNotNull(h.str("summary").takeIf { h.str("kind") == "send" }, h.str("project")).joinToString(" · ")
                            + (h.str("error")?.let { "\nHeld again: $it" } ?: ""),
                        onClick = { nav("needs/$id") })
                }
            }
            items(d.asks, key = { "a" + it.str("id") }) { a ->
                val id = a.str("id") ?: return@items
                val summary = a.str("summary").orEmpty()
                Swipe(onRight = { decide.answer(a, "allow") }, rightLabel = "Allow", onLeft = { decide.answer(a, "deny") }, leftLabel = "Deny") {
                    NeedCard("Permission", listOfNotNull(agentOf[a.str("thread")], ago(a.str("at")?.toLongOrNull())).joinToString(" · "),
                        title = {
                            Text(buildAnnotatedString {
                                withStyle(SpanStyle(fontWeight = Type.bodyStrong.fontWeight)) { append("May I run ") }
                                withStyle(SpanStyle(fontFamily = Type.code.fontFamily)) { append(summary) }
                            }, style = Type.body, color = V.c.text, maxLines = 3)
                        },
                        sub = a.str("destination") ?: a.str("reason"), onClick = { nav("needs/$id") })
                }
            }
        }
        if (d != null) {
            item { SectionHead("Working · ${working.size}", if (working.isNotEmpty()) "Tap to watch" else null) }
            if (working.isEmpty()) item { Quiet("No session is running.") }
            items(working, key = { "t" + it.str("id") }) { t ->
                val status = t.str("status")
                Row2(t.str("name") ?: t.str("id").orEmpty().take(8),
                    listOfNotNull(t.str("agent"), t.str("project"), if (status == "waiting") "waiting on you" else ago(t.str("last")?.toLongOrNull())).joinToString(" · "),
                    onClick = { nav("thread/${t.str("id")}") })
            }
        }
    }
}


/** Swipe right and left on a card, with the same two actions offered to TalkBack. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun Swipe(onRight: () -> Unit, rightLabel: String, onLeft: () -> Unit, leftLabel: String, content: @Composable () -> Unit) {
    val state = rememberSwipeToDismissBoxState(confirmValueChange = { v ->
        when (v) {
            SwipeToDismissBoxValue.StartToEnd -> onRight()
            SwipeToDismissBoxValue.EndToStart -> onLeft()
            else -> {}
        }
        false // the card stays until the box says it is gone
    }, positionalThreshold = { it * 0.4f })
    SwipeToDismissBox(state, modifier = Modifier.semantics {
        customActions = listOf(CustomAccessibilityAction(rightLabel) { onRight(); true }, CustomAccessibilityAction(leftLabel) { onLeft(); true })
    }, backgroundContent = {
        val dir = state.dismissDirection
        // Nothing behind the card at rest: its Beacon wash is translucent, so a label here would show through.
        if (dir == SwipeToDismissBoxValue.Settled) return@SwipeToDismissBox
        Box(Modifier.fillMaxSize().padding(vertical = 4.dp).background(V.c.panel), contentAlignment = if (dir == SwipeToDismissBoxValue.EndToStart) Alignment.CenterEnd else Alignment.CenterStart) {
            Label(if (dir == SwipeToDismissBoxValue.EndToStart) leftLabel else rightLabel, Modifier.padding(horizontal = Space.l), if (dir == SwipeToDismissBoxValue.StartToEnd) V.c.focus else V.c.label)
        }
    }) { content() }
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
