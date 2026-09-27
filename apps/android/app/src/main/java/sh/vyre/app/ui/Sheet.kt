package sh.vyre.app.ui

import android.os.Build
import android.view.HapticFeedbackConstants
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import sh.vyre.app.VyreApp
import sh.vyre.app.api.ApiError
import sh.vyre.app.api.arr
import sh.vyre.app.api.at
import sh.vyre.app.api.bool
import sh.vyre.app.api.input
import sh.vyre.app.api.plain
import sh.vyre.app.api.str
import sh.vyre.app.data.Anchor
import sh.vyre.app.data.AskView
import sh.vyre.app.data.Gate
import sh.vyre.app.data.Held
import sh.vyre.app.data.HeldField
import sh.vyre.app.data.Pick
import sh.vyre.app.data.Questions
import sh.vyre.app.data.answerInput
import sh.vyre.app.data.heldFor
import sh.vyre.app.design.ButtonKind
import sh.vyre.app.design.Failure
import sh.vyre.app.design.Glyph
import sh.vyre.app.design.Radius
import sh.vyre.app.design.Space
import sh.vyre.app.design.Type
import sh.vyre.app.design.V
import sh.vyre.app.design.VButton

/** What the detail sheet shows: an open ask or question, or a held item, and whose it is. */
data class NeedData(val ask: JsonElement?, val item: JsonElement?, val agent: String?, val project: String?)

/** Read one need by id: threads.asks first (asks and questions), else gate.get. Throws when it is neither. */
suspend fun loadNeed(app: VyreApp, id: String): NeedData = coroutineScope {
    val asks = async { runCatching { app.client.call("threads.asks").arr.toList() }.getOrDefault(emptyList()) }
    val threads = async { runCatching { app.client.call("threads.list", input("all" to true)).arr.toList() }.getOrDefault(emptyList()) }
    val ask = asks.await().firstOrNull { it.str("id") == id }
    val item = if (ask == null) app.client.call("gate.get", input("id" to id)) else null
    val t = threads.await().firstOrNull { it.str("id") == (ask?.str("thread") ?: item?.str("thread")) }
    NeedData(ask, item, ask?.str("agent") ?: item?.str("agent") ?: t?.str("agent"), item?.str("project") ?: t?.str("project"))
}

private fun haptic(view: android.view.View, yes: Boolean) {
    view.performHapticFeedback(if (Build.VERSION.SDK_INT >= 30) (if (yes) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.REJECT) else HapticFeedbackConstants.LONG_PRESS)
}

/**
 * Deny or Discard with Undo (phone.md section 4): the row leaves at once, the toast offers Undo
 * for 4 s, and only then does the answer go. If the box wants a proof for it, the fingerprint
 * sheet shows then, naming the item. A failure brings the row back and says why.
 */
fun declineAfterUndo(app: VyreApp, id: String, tool: String, body: JsonObject, reason: String, done: String, toast: (Toast) -> Unit, failed: (String) -> Unit = {}) {
    app.settled.value = app.settled.value + id
    var undone = false
    toast(Toast(done, "Undo", 4000, onAction = { undone = true; app.settled.value = app.settled.value - id }))
    app.scope.launch(Dispatchers.Main) {
        delay(4000)
        if (undone) return@launch
        try { app.client.callOrProve(tool, body, reason, session = true) }
        catch (e: ApiError.Cancelled) { app.settled.value = app.settled.value - id; failed("Cancelled.") }
        catch (e: Exception) { app.settled.value = app.settled.value - id; failed(e.plain()); toast(Toast("Not done: ${e.plain()}")) }
    }
}

/**
 * The detail sheet (phone.md section 5), for an ask, a held draft or a question: every Needs you
 * row opens it, and so does a push's /needs/<id>. The header names who asks and where, the title,
 * how long it has been held, and Open session (the exact session, scrolled to where it was
 * raised). The body scrolls; the actions stay pinned above the bottom inset. Held, ask and question
 * cards are neutral: the attention colour is only the dot and the "Held" label.
 */
@Composable
fun NeedSheet(id: String, onClose: () -> Unit) {
    val app = LocalApp.current
    val go = LocalGo.current
    val load = rememberLoad("need", id) { loadNeed(app, id) }
    var busy by remember(id) { mutableStateOf(false) }
    // An ask closed elsewhere, or a draft sent or discarded elsewhere, re-reads; never while a tap is going through.
    OnEvents("ask.answered", "gate.released", "gate.rejected", "gate.failed", "gate.revised") { e ->
        if (!busy && (e.str("ask") == id || e.str("id") == id)) load.refresh()
    }
    val d = load.v.value
    val c = V.c
    // "Always in <project>" can arrive a moment after the ask (phone.md section 15): read once more.
    LaunchedEffect(d?.ask?.str("id"), d?.ask?.bool("always"), d?.ask?.str("always_project")) {
        val a = d?.ask ?: return@LaunchedEffect
        if (a.bool("always") == true && a.str("always_project") == null) { delay(1500); if (!busy) load.refresh() }
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        if (d == null) {
            Column(Modifier.padding(horizontal = 20.dp, vertical = Space.l)) {
                CloseRow(onClose)
                val e = load.v.error
                if (e == null) Text("Loading", style = Type.secondary, color = c.label)
                else Failure(if (e is ApiError.Other && e.message.contains("nothing at the Gate")) "It was already answered." else e.plain())
            }
            return@Column
        }
        val src = d.ask ?: d.item
        val thread = src.str("thread")
        val openRoute = Anchor.route(thread, Anchor.of(src))
        val title = when {
            d.ask?.str("kind") == "question" -> "${d.agent ?: "Vyre"} has a question"
            d.ask != null -> sh.vyre.app.data.Needs.askTitle(d.ask.str("tool"), d.ask.str("summary"), d.ask.str("destination"))
            else -> sh.vyre.app.data.Needs.draftTitle(d.item!!)
        }
        val header: @Composable ColumnScope.() -> Unit = {
            SheetHeader(d.agent, d.project, title, src.str("at")?.toLongOrNull(), openRoute?.let { r -> { go(r) } }, onClose)
        }
        when {
            d.ask?.str("kind") == "question" -> QuestionBody(d.ask!!, header, onDone = onClose, busy = { busy = it })
            d.ask != null -> AskBody(d.ask, d.agent, d.project, header, onDone = onClose, busy = { busy = it })
            else -> DraftBody(d.item!!, header, onDone = onClose, busy = { busy = it }, reload = { load.refresh() })
        }
    }
}

/** Only the close button, for the sheet while it loads or when the item is gone. */
@Composable
private fun CloseRow(onClose: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(bottom = Space.m), horizontalArrangement = Arrangement.End) { CloseButton(onClose) }
}

@Composable
private fun CloseButton(onClose: () -> Unit) {
    val c = V.c
    Box(Modifier.size(44.dp).clickable(role = Role.Button, onClickLabel = "Close", onClick = onClose).semantics { contentDescription = "Close" }, contentAlignment = Alignment.Center) {
        Box(Modifier.size(30.dp).clip(CircleShape).background(c.hover).border(1.dp, c.rule, CircleShape), contentAlignment = Alignment.Center) { Glyph.Close(c.text2, 14.dp) }
    }
}

/**
 * The sheet's header (phone.md section 5): a 22 px tile and "<agent> asks · <project>" with the
 * close button; the title in Sheet title type; the attention dot and "Held 4 min", with Open
 * session on the right.
 */
@Composable
private fun SheetHeader(agent: String?, project: String?, title: String, at: Long?, openSession: (() -> Unit)?, onClose: () -> Unit) {
    val c = V.c
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(22.dp).clip(RoundedCornerShape(6.dp)).background(c.hover).border(1.dp, c.ruleStrong, RoundedCornerShape(6.dp)), contentAlignment = Alignment.Center) {
            Text((agent ?: "V").take(1).uppercase(), style = Type.micro.copy(fontWeight = FontWeight(600)), color = c.text)
        }
        Spacer(Modifier.width(Space.s))
        Text(dots((agent ?: "Vyre") + " asks", project), style = Type.meta, color = c.text2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        CloseButton(onClose)
    }
    Text(title, style = Type.sheetTitle, color = c.text, modifier = Modifier.padding(top = Space.m).semantics { heading() })
    Row(Modifier.fillMaxWidth().heightIn(min = 44.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(7.dp).clip(CircleShape).background(c.beaconDot))
        Spacer(Modifier.width(Space.s))
        Text(heldFor(at), style = Type.secondary, color = c.beaconInk, modifier = Modifier.weight(1f))
        if (openSession != null) Row(Modifier.heightIn(min = 44.dp).clickable(role = Role.Button, onClick = openSession).padding(start = Space.m), verticalAlignment = Alignment.CenterVertically) {
            Text("Open session", style = Type.button, color = c.text)
            Spacer(Modifier.width(4.dp))
            Glyph.Chevron(c.text, 16.dp)
        }
    }
}

/**
 * The frame every kind shares: the header and body scroll, the actions stay pinned at the
 * bottom (8 between buttons, above the navigation bar), a failure above them.
 */
@Composable
private fun ColumnScope.Framed(header: @Composable ColumnScope.() -> Unit, failure: String?, body: @Composable ColumnScope.() -> Unit, actions: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = Space.l)) {
        header()
        body()
    }
    Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(start = 20.dp, end = 20.dp, top = Space.s, bottom = Space.l), verticalArrangement = Arrangement.spacedBy(Space.s)) {
        if (failure != null) Failure(failure, Modifier.padding(bottom = 4.dp))
        actions()
    }
}

/** The fingerprint glyph at 22, in the button's ink. */
val FingerprintIcon: @Composable (androidx.compose.ui.graphics.Color) -> Unit = { ink -> Glyph.Fingerprint(ink, 22.dp) }

/** The primary action, 54 tall, full width, with the fingerprint glyph only when the box says one is needed. */
@Composable
private fun PrimaryAction(text: String, glyph: Boolean, enabled: Boolean, onClick: () -> Unit) {
    VButton(text, onClick = onClick, kind = ButtonKind.Primary, enabled = enabled, height = 54.dp, modifier = Modifier.fillMaxWidth(),
        icon = FingerprintIcon.takeIf { glyph })
}

private val MoreIcon: @Composable () -> Unit = { Glyph.Chevron(V.c.label, 16.dp, Modifier.padding(start = 4.dp)) }

/** A command block: mono 14/20 on --code-bg (--bg on paper), a --rule border, radius 8, `$` in --label. */
@Composable
fun CommandBlock(command: String, modifier: Modifier = Modifier, radius: androidx.compose.ui.unit.Dp = 8.dp) {
    val c = V.c
    val shape = RoundedCornerShape(radius)
    Text(buildAnnotatedString { withStyle(SpanStyle(color = c.label)) { append("$ ") }; append(command) }, style = Type.command, color = c.text,
        modifier = modifier.fillMaxWidth().clip(shape).background(if (c.dark) c.codeBg else c.bg).border(1.dp, c.rule, shape).padding(horizontal = 14.dp, vertical = 12.dp))
}

/** A fact row between hairlines: the label on the left in --label, the value on the right in --text. */
@Composable
private fun FactRow(label: String, value: String, mono: Boolean = false, onClick: (() -> Unit)? = null, trailing: (@Composable () -> Unit)? = null) {
    val c = V.c
    Column {
        Row(Modifier.fillMaxWidth().heightIn(min = 44.dp).then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier).padding(vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Text(label, style = Type.secondary, color = c.label)
            Spacer(Modifier.width(Space.l))
            Text(value, style = if (mono) Type.commandRow else Type.secondary, color = if (mono) c.text2 else c.text, maxLines = 2, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f), textAlign = androidx.compose.ui.text.style.TextAlign.End)
            trailing?.invoke()
        }
        sh.vyre.app.design.Hairline()
    }
}

/** Diff lines: + on --signal-wash, - on --del-wash with --text-2 text (never the attention colour). */
@Composable
private fun DiffLines(lines: List<Pair<Char, String>>) {
    val c = V.c
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).border(1.dp, c.rule, RoundedCornerShape(8.dp))) {
        for ((sign, text) in lines.take(200)) Text("$sign $text", style = Type.log, color = if (sign == '-') c.text2 else c.text,
            modifier = Modifier.fillMaxWidth().background(if (sign == '-') c.delWash else c.signalWash).padding(horizontal = 10.dp, vertical = 1.dp))
    }
}

// ---- Ask ----

@Composable
private fun ColumnScope.AskBody(ask: JsonElement, agent: String?, project: String?, header: @Composable ColumnScope.() -> Unit, onDone: () -> Unit, busy: (Boolean) -> Unit) {
    val app = LocalApp.current
    val view = LocalView.current
    val toast = LocalToast.current
    val c = V.c
    val id = ask.str("id") ?: return
    var working by remember(id) { mutableStateOf(false) }
    var failure by remember(id) { mutableStateOf<String?>(null) }
    var changesOpen by remember(id) { mutableStateOf(false) }
    // The button appears only when the box names the project, and never moves while a tap is going through.
    val alwaysProject = ask.str("always_project")
    var shownAlways by remember(id) { mutableStateOf(alwaysProject) }
    LaunchedEffect(alwaysProject, working) { if (!working) shownAlways = alwaysProject }
    val command = AskView.command(ask)
    val glyph = Gate.glyph(ask)

    fun answer(decision: String) {
        if (working) return
        working = true; busy(true); failure = null
        val body = answerInput(id, decision, SURFACE, scope = if (decision == "always") "project" else null)
        val reason = when (decision) { "always" -> "Always allow in ${shownAlways ?: "this project"}: $command"; else -> "Approve: $command" }
        app.scope.launch(Dispatchers.Main) {
            try {
                val out = app.client.callOrProve("threads.answer", body, reason, required = Gate.required(ask), session = true)
                if (out.str("answered") == "false") failure = out.str("note") ?: "It was already answered."
                else { haptic(view, true); app.settled.value = app.settled.value + id; onDone() }
            } catch (e: ApiError.Cancelled) { } catch (e: Exception) { failure = e.plain() }
            working = false; busy(false)
        }
    }

    Framed(header, failure, body = {
        CommandBlock(command, Modifier.padding(top = Space.m))
        AskView.why(ask)?.let { why ->
            Text("Why ${agent ?: "Vyre"} wants to", style = Type.meta.copy(fontWeight = FontWeight(600)), color = c.label, modifier = Modifier.padding(top = Space.l))
            Text(why, style = Type.body, color = c.text, modifier = Modifier.padding(top = 4.dp))
        }
        Column(Modifier.padding(top = Space.l)) {
            val facts = AskView.facts(ask)
            if (facts.isNotEmpty()) sh.vyre.app.design.Hairline()
            for (f in facts) FactRow(f.label, f.value)
            AskView.changes(ask)?.let { ch ->
                if (facts.isEmpty()) sh.vyre.app.design.Hairline()
                FactRow("Changes", ch.line, mono = true, onClick = if (ch.list.isNotEmpty()) ({ changesOpen = !changesOpen }) else null,
                    trailing = MoreIcon.takeIf { ch.list.isNotEmpty() })
                if (changesOpen) Column(Modifier.animateContentSize(tween(180))) {
                    for (f in ch.list) FactRow(f.file, "+${f.added} -${f.removed}", mono = true)
                }
            }
        }
        AskView.diff(ask).takeIf { it.isNotEmpty() }?.let { lines ->
            Text("The change", style = Type.meta.copy(fontWeight = FontWeight(600)), color = c.label, modifier = Modifier.padding(top = Space.l, bottom = 6.dp))
            DiffLines(lines)
        }
    }) {
        PrimaryAction(if (glyph) "Approve with fingerprint" else "Approve", glyph, !working) { answer("allow") }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Space.s)) {
            shownAlways?.let { p -> VButton("Always in $p", onClick = { answer("always") }, enabled = !working, height = 46.dp, modifier = Modifier.weight(1f)) }
            VButton("Deny", enabled = !working, height = 46.dp, modifier = Modifier.weight(1f), onClick = {
                onDone()
                declineAfterUndo(app, id, "threads.answer", answerInput(id, "deny", SURFACE), "Deny: $command", "Denied: ${sh.vyre.app.data.Needs.askTitle(ask.str("tool"), ask.str("summary"), ask.str("destination"))}", toast)
                haptic(view, false)
            })
        }
    }
}

// ---- Draft ----

/**
 * A held draft: To, Subject and Body (and any other field) edit in place: tap into them. There is
 * no Edit button, and the only actions are Send and Discard; an edit makes the primary "Send
 * edited". Floor rule 1: what goes is what is on screen. Before any proof the item is read again,
 * and if it changed meanwhile nothing goes and the new words are shown.
 */
@Composable
private fun ColumnScope.DraftBody(item: JsonElement, header: @Composable ColumnScope.() -> Unit, onDone: () -> Unit, busy: (Boolean) -> Unit, reload: () -> Unit) {
    val app = LocalApp.current
    val view = LocalView.current
    val toast = LocalToast.current
    val c = V.c
    val id = item.str("id") ?: return
    val state = item.str("state") ?: "held"
    val fields = remember(item) { Held.fields(item) }
    val values = remember(id) { mutableStateMapOf<String, String>() }
    LaunchedEffect(item) { for (f in fields) if (f.key !in values) values[f.key] = f.original }
    var working by remember(id) { mutableStateOf(false) }
    var failure by remember(id) { mutableStateOf<String?>(item.str("error")?.let { "Held again: $it" }) }
    val shown = remember(item) { Held.shown(item) }
    val edited = try { Held.edited(fields, values) } catch (e: IllegalArgumentException) { null }
    val verb = Held.action(item.str("kind"))
    val glyph = Gate.glyph(item)

    fun send() {
        if (working) return
        val edit = try { Held.edited(fields, values) } catch (e: IllegalArgumentException) { failure = e.message; return }
        working = true; busy(true); failure = null
        val reason = Held.reason(item, verb)
        app.scope.launch(Dispatchers.Main) {
            try {
                // What was shown must still be what goes: the item is read again before each proved attempt.
                var expect = shown
                val check: suspend () -> Unit = {
                    val now = app.client.call("gate.get", input("id" to id))
                    if (Held.shown(now) != expect) throw Changed(now)
                }
                val out = if (edit == null) app.client.callOrProve("gate.approve", input("id" to id), reason, required = Gate.required(item), session = true, check = check)
                else {
                    // The edit is saved with gate.revise, then sent as it now stands. When saving it
                    // would need its own fingerprint, the same edit rides gate.approve instead: one
                    // proof for one send, never two.
                    val revised = try { app.client.callOrProve("gate.revise", input("id" to id, "edited" to edit), reason, session = true, prompt = false) }
                        catch (e: ApiError.PresenceRequired) { null }
                    if (revised != null) { expect = Held.shown(revised); app.client.callOrProve("gate.approve", input("id" to id), reason, required = Gate.required(item), session = true, check = check) }
                    else app.client.callOrProve("gate.approve", input("id" to id, "edited" to edit), reason, required = Gate.required(item), session = true, check = check)
                }
                if (out.str("state") == "failed") failure = "Held again: ${out.str("error") ?: "the send failed"}"
                else { haptic(view, true); app.settled.value = app.settled.value + id; onDone() }
            } catch (e: Changed) {
                failure = if (e.now.str("state") == "held") "It changed while you read it. Nothing was sent; read it again." else "It is already ${e.now.str("state")}."
                values.clear(); reload()
            } catch (e: ApiError.Cancelled) { } catch (e: Exception) { failure = e.plain() }
            working = false; busy(false)
        }
    }

    Framed(header, failure, body = {
        Column(Modifier.padding(top = Space.m)) {
            sh.vyre.app.design.Hairline()
            for (f in fields.filter { it.key != "body" }) EditRow(f, values[f.key] ?: f.original, state == "held" && !working) { values[f.key] = it }
            fields.firstOrNull { it.key == "body" }?.let { f -> EditBody(f, values[f.key] ?: f.original, state == "held" && !working) { values[f.key] = it } }
        }
        Sources(item)
        if (state != "held") Text(when (state) { "sent" -> "Sent."; "rejected" -> "Discarded."; "sending" -> "Sending"; else -> state }, style = Type.secondary, color = c.label, modifier = Modifier.padding(top = Space.m))
    }) {
        if (state == "held") {
            val label = when { edited != null -> "$verb edited"; glyph -> "$verb with fingerprint"; else -> verb }
            PrimaryAction(label, glyph, !working) { send() }
            VButton("Discard", enabled = !working, height = 46.dp, modifier = Modifier.fillMaxWidth(), onClick = {
                onDone()
                declineAfterUndo(app, id, "gate.reject", input("id" to id), Held.reason(item, "Discard"), "Discarded: ${sh.vyre.app.data.Needs.draftTitle(item)}", toast)
                haptic(view, false)
            })
        }
    }
}

/** The item moved between being shown and being sent; nothing went. */
private class Changed(val now: JsonElement) : Exception("changed")

/** One field in a row: its label in --label on the left, its words on the right, editable where they are. */
@Composable
private fun EditRow(f: HeldField, value: String, enabled: Boolean, onChange: (String) -> Unit) {
    val c = V.c
    val mono = f.json || f.key == "url" || f.key == "method"
    Column {
        Row(Modifier.fillMaxWidth().heightIn(min = 44.dp).padding(vertical = 10.dp), verticalAlignment = if (f.multiline) Alignment.Top else Alignment.CenterVertically) {
            Text(f.label, style = Type.secondary, color = c.label, modifier = Modifier.width(76.dp))
            BasicTextField(value, onChange, enabled = enabled, singleLine = !f.multiline,
                textStyle = (if (mono) Type.commandRow else Type.secondary).copy(color = c.text), cursorBrush = SolidColor(c.focus),
                modifier = Modifier.weight(1f).semantics { contentDescription = "${f.label}: $value. Edit in place." })
        }
        sh.vyre.app.design.Hairline()
    }
}

/** The body, below the fields: its words, editable in place, 16/23. */
@Composable
private fun EditBody(f: HeldField, value: String, enabled: Boolean, onChange: (String) -> Unit) {
    val c = V.c
    BasicTextField(value, onChange, enabled = enabled, textStyle = Type.body.copy(color = c.text), cursorBrush = SolidColor(c.focus),
        modifier = Modifier.fillMaxWidth().padding(vertical = Space.m).semantics { contentDescription = "Body. Edit in place." })
}

/** What the draft drew from, if the box says: a From memory block. */
@Composable
private fun Sources(item: JsonElement) {
    val list = item.at("sources").arr.mapNotNull { it.str("text") ?: it.str("title") ?: it.str("name") ?: (it as? kotlinx.serialization.json.JsonPrimitive)?.content }
    if (list.isEmpty()) return
    val c = V.c
    Column(Modifier.fillMaxWidth().padding(top = Space.m).clip(RoundedCornerShape(Radius.panel)).background(c.recallWash).padding(horizontal = 14.dp, vertical = 12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Glyph.History(c.recall, 14.dp); Spacer(Modifier.width(6.dp))
            Text("From memory", style = Type.meta.copy(fontWeight = FontWeight(600)), color = c.recall)
        }
        for (s in list) Text(s, style = Type.secondary, color = c.text, modifier = Modifier.padding(top = 6.dp))
    }
}

// ---- Question ----

/**
 * A question (threads.asks kind "question"): each question in Lead type, then its choices as
 * full-width rows; the last row takes typed text ("Something else"). Answer is enabled once every
 * question has an answer; Later declines it. No proof unless the box asks for one.
 */
@Composable
private fun ColumnScope.QuestionBody(ask: JsonElement, header: @Composable ColumnScope.() -> Unit, onDone: () -> Unit, busy: (Boolean) -> Unit) {
    val app = LocalApp.current
    val view = LocalView.current
    val toast = LocalToast.current
    val id = ask.str("id") ?: return
    val qs = remember(ask) { Questions.of(ask) }
    val picks = remember(id, qs.size) { mutableStateListOf<Pick>().apply { repeat(qs.size) { add(Pick()) } } }
    var working by remember(id) { mutableStateOf(false) }
    var failure by remember(id) { mutableStateOf<String?>(null) }
    val answers = Questions.answers(qs, picks)

    fun submit() {
        val a = answers ?: return
        if (working) return
        working = true; busy(true); failure = null
        app.scope.launch(Dispatchers.Main) {
            try {
                val out = app.client.callOrProve("threads.answer", answerInput(id, "allow", SURFACE, answers = a), "Answer: " + a.values.joinToString("; "),
                    required = Gate.required(ask), session = true)
                if (out.str("answered") == "false") failure = out.str("note") ?: "It was already answered."
                else { haptic(view, true); app.settled.value = app.settled.value + id; onDone() }
            } catch (e: ApiError.Cancelled) { } catch (e: Exception) { failure = e.plain() }
            working = false; busy(false)
        }
    }

    Framed(header, failure, body = {
        if (qs.isEmpty()) Text(ask.str("summary") ?: "Reading the question", style = Type.lead, color = V.c.text, modifier = Modifier.padding(top = Space.m))
        qs.forEachIndexed { i, q ->
            QuestionBlock(q, picks[i], enabled = !working) { picks[i] = it }
        }
    }) {
        PrimaryAction("Answer", Gate.glyph(ask), answers != null && !working) { submit() }
        VButton("Later", enabled = !working, height = 46.dp, modifier = Modifier.fillMaxWidth(), onClick = {
            onDone()
            declineAfterUndo(app, id, "threads.answer", answerInput(id, "deny", SURFACE), "Decline the question", "Later: the question is declined", toast)
        })
    }
}

@Composable
private fun QuestionBlock(q: sh.vyre.app.data.Question, pick: Pick, enabled: Boolean, set: (Pick) -> Unit) {
    val c = V.c
    Column(Modifier.padding(top = Space.l), verticalArrangement = Arrangement.spacedBy(Space.s)) {
        q.header?.let { Text(it, style = Type.micro, color = c.label) }
        Text(q.question, style = Type.lead, color = c.text, modifier = Modifier.padding(bottom = 4.dp))
        for (o in q.options) ChoiceRow(o.label, o.description, o.label in pick.chosen, enabled) { set(Questions.choose(q, pick, o.label)) }
        OtherRow(pick, enabled, onSelect = { if (!pick.other || q.multi) set(Questions.choose(q, pick, null)) }, onText = { t ->
            set((if (pick.other) pick else Questions.choose(q, pick, null)).copy(text = t))
        })
    }
}

/** A choice: full width, radius 10, --rule-strong, 52 tall; picked, --signal-wash with a --focus border. */
@Composable
private fun ChoiceRow(label: String, note: String?, on: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val c = V.c
    val shape = RoundedCornerShape(10.dp)
    Column(Modifier.fillMaxWidth().heightIn(min = 52.dp).clip(shape).background(if (on) c.signalWash else androidx.compose.ui.graphics.Color.Transparent)
        .border(1.dp, if (on) c.focus else c.ruleStrong, shape).clickable(enabled = enabled, role = Role.RadioButton, onClick = onClick)
        .semantics { selected = on }.padding(horizontal = 14.dp, vertical = 10.dp), verticalArrangement = Arrangement.Center) {
        Text(label, style = Type.rowTitle, color = c.text)
        note?.let { Text(it, style = Type.meta, color = if (on) c.text2 else c.label) }
    }
}

/** The last row: "Something else", typed. Typing picks it. */
@Composable
private fun OtherRow(pick: Pick, enabled: Boolean, onSelect: () -> Unit, onText: (String) -> Unit) {
    val c = V.c
    val shape = RoundedCornerShape(10.dp)
    val focus = remember { FocusRequester() }
    Box(Modifier.fillMaxWidth().heightIn(min = 52.dp).clip(shape).background(if (pick.other) c.signalWash else androidx.compose.ui.graphics.Color.Transparent)
        .border(1.dp, if (pick.other) c.focus else c.ruleStrong, shape).clickable(enabled = enabled) { onSelect(); runCatching { focus.requestFocus() } }
        .padding(horizontal = 14.dp, vertical = 14.dp), contentAlignment = Alignment.CenterStart) {
        BasicTextField(pick.text, onText, enabled = enabled, textStyle = Type.input.copy(color = c.text, fontSize = 16.sp), cursorBrush = SolidColor(c.focus),
            modifier = Modifier.fillMaxWidth().focusRequester(focus).semantics { contentDescription = "Something else" },
            decorationBox = { inner -> if (pick.text.isEmpty()) Text("Something else", style = Type.input.copy(fontSize = 16.sp), color = c.label); inner() })
    }
}

/** The grabber on top of the sheet: 36 x 5, --rule-strong. */
@Composable
fun Grabber() {
    Box(Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 8.dp), contentAlignment = Alignment.Center) {
        Box(Modifier.size(width = 36.dp, height = 5.dp).clip(RoundedCornerShape(3.dp)).background(V.c.ruleStrong))
    }
}
