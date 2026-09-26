package sh.vyre.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import sh.vyre.app.api.ApiError
import sh.vyre.app.api.input
import sh.vyre.app.api.plain
import sh.vyre.app.api.str
import sh.vyre.app.data.Held
import sh.vyre.app.data.HeldField
import sh.vyre.app.data.ago
import sh.vyre.app.design.ButtonKind
import sh.vyre.app.design.Dot
import sh.vyre.app.design.Hairline
import sh.vyre.app.design.Label
import sh.vyre.app.design.Radius
import sh.vyre.app.design.Space
import sh.vyre.app.design.Type
import sh.vyre.app.design.V
import sh.vyre.app.design.VButton

/** The summary card a held item or an ask reads as in a list: Beacon wash, a label, a title. */
@Composable
fun NeedCard(label: String, meta: String, title: @Composable () -> Unit, sub: String?, onClick: () -> Unit) {
    val c = V.c
    Column(
        Modifier.fillMaxWidth().padding(vertical = 4.dp).clip(RoundedCornerShape(Radius.panel)).background(c.bg).background(c.beaconWash)
            .clickable(role = Role.Button, onClick = onClick).padding(horizontal = Space.l, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Dot(c.beaconDot); Spacer(Modifier.width(Space.s)); Label(label, Modifier.weight(1f), c.beaconInk)
            Text(meta, style = Type.monoSmall, color = c.text2)
        }
        title()
        if (!sub.isNullOrEmpty()) Text(sub, style = Type.small, color = c.text2, maxLines = 2)
    }
}

/**
 * A held item, whole: its words as fields that read as text and become editable on tap (no Edit
 * button), then Send or Approve (the one Signal button) and Discard. Both sign with the device
 * key, the item's summary on the fingerprint sheet. A failed send stays held with the edit kept.
 */
@Composable
fun HeldItem(id: String, onDone: (String) -> Unit, inline: Boolean = false) {
    val app = LocalApp.current
    val haptic = rememberHaptic()
    val scope = rememberCoroutineScope()
    val load = rememberLoad(id) { app.client.call("gate.get", input("id" to id)) }
    val item = load.v.value
    val values = remember(id) { mutableStateMapOf<String, String>() }
    var editing by remember(id) { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var note by remember(id) { mutableStateOf<String?>(null) }
    var failed by remember(id) { mutableStateOf<String?>(null) }
    OnEvents("gate.released", "gate.rejected", "gate.failed") { e -> if (e.str("id") == id && !busy) load.refresh() }

    val c = V.c
    if (item == null) {
        Quiet(load.v.error?.plain() ?: "Loading", if (load.v.error != null) "failed" else null)
        return
    }
    val state = item.str("state") ?: "held"
    val fields = remember(item) { Held.fields(item) }
    LaunchedEffect(item) { for (f in fields) if (f.key !in values) values[f.key] = f.original }
    val err = failed ?: item.str("error")

    Column(Modifier.fillMaxWidth()) {
        if (!inline) {
            Text(Held.title(item), style = Type.h2, color = c.text, modifier = Modifier.padding(top = Space.s))
            val who = listOfNotNull(item.str("agent")?.let { "$it wrote this ${ago(item.str("at")?.toLongOrNull())} ago." }, item.str("why")).joinToString(" ")
            if (who.isNotEmpty()) Text(who, style = Type.small, color = c.text2, modifier = Modifier.padding(top = 4.dp, bottom = Space.l))
        } else {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = Space.s)) {
                Dot(c.beaconDot); Spacer(Modifier.width(Space.s)); Label("Held at the Gate", Modifier.weight(1f), c.beaconInk)
                Text(item.str("agent").orEmpty(), style = Type.monoSmall, color = c.text2)
            }
            Text(Held.title(item), style = Type.h3, color = c.text)
        }
        if (err != null && state == "held") Text("Held again: $err", style = Type.small, color = c.beaconInk, modifier = Modifier.padding(vertical = Space.s))

        Hairline()
        for (f in fields) FieldRow(f, values[f.key] ?: f.original, editing == f.key, enabled = state == "held" && !busy,
            onTap = { editing = f.key }, onChange = { values[f.key] = it }, onDone = { editing = null })

        when (state) {
            "held" -> Row(Modifier.fillMaxWidth().padding(top = Space.l), horizontalArrangement = Arrangement.spacedBy(Space.s)) {
                VButton(Held.action(item.str("kind")), enabled = !busy, kind = ButtonKind.Primary, leading = "→", modifier = Modifier.weight(1f), onClick = {
                    val edited = try { Held.edited(fields, values) } catch (e: IllegalArgumentException) { note = e.message; return@VButton }
                    busy = true; note = null
                    scope.launch {
                        try {
                            val out = app.client.callProved("gate.approve", input("id" to id, "edited" to edited), Held.reason(item, Held.action(item.str("kind"))))
                            if (out.str("state") == "failed") { failed = out.str("error") ?: "the send failed"; editing = null }
                            else { haptic(); failed = null; onDone("sent") }
                        } catch (e: ApiError.Cancelled) { } catch (e: Exception) { failed = e.plain() }
                        busy = false
                    }
                })
                VButton("Discard", enabled = !busy, onClick = {
                    busy = true
                    scope.launch {
                        try { app.client.callProved("gate.reject", input("id" to id), Held.reason(item, "Discard")); onDone("discarded") }
                        catch (e: ApiError.Cancelled) { } catch (e: Exception) { note = e.plain() }
                        busy = false
                    }
                })
            }
            else -> Quiet(when (state) { "sent" -> "Sent."; "rejected" -> "Discarded."; "sending" -> "Sending"; else -> state })
        }
        note?.let { Text(it, style = Type.small, color = c.text2, modifier = Modifier.padding(top = Space.s)) }
    }
}

/** One field: engraved label, the words as text; tap and the same words become editable where they are. */
@Composable
private fun FieldRow(f: HeldField, value: String, editing: Boolean, enabled: Boolean, onTap: () -> Unit, onChange: (String) -> Unit, onDone: () -> Unit) {
    val c = V.c
    val body = f.key == "body"
    val style = if (f.json || f.key == "url" || f.key == "method") Type.code.copy(color = c.text) else Type.body.copy(color = c.text)
    Column(Modifier.fillMaxWidth()) {
        val mod = if (body) Modifier.fillMaxWidth().padding(vertical = Space.m).clip(RoundedCornerShape(Radius.panel)).background(c.panel).padding(Space.l)
        else Modifier.fillMaxWidth().heightIn(min = Space.target).padding(vertical = Space.m)
        Row(mod, verticalAlignment = if (f.multiline) Alignment.Top else Alignment.CenterVertically) {
            if (!body) { Label(f.label, Modifier.width(76.dp)); Spacer(Modifier.width(Space.s)) }
            if (editing && enabled) {
                val fr = remember { FocusRequester() }
                LaunchedEffect(Unit) { fr.requestFocus() }
                BasicTextField(value, onChange, textStyle = style, cursorBrush = SolidColor(c.focus), singleLine = !f.multiline,
                    modifier = Modifier.weight(1f).focusRequester(fr).border(0.dp, c.focus).semantics { contentDescription = "${f.label}, editing" })
            } else {
                Text(value.ifEmpty { " " }, style = style, modifier = Modifier.weight(1f)
                    .then(if (enabled) Modifier.clickable(onClickLabel = "Edit ${f.label}", onClick = onTap) else Modifier)
                    .semantics { contentDescription = "${f.label}: $value. Tap to edit." })
            }
        }
        if (!body) Hairline()
    }
    if (!editing) Unit
}

/** A session asking before it runs something: Allow or Deny, signed with the device key. */
@Composable
fun AskItem(ask: JsonElement, agent: String?, onDone: () -> Unit) {
    val app = LocalApp.current
    val scope = rememberCoroutineScope()
    val haptic = rememberHaptic()
    var busy by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }
    val c = V.c
    val id = ask.str("id") ?: ask.str("ask") ?: return
    val summary = ask.str("summary").orEmpty()
    fun answer(decision: String) {
        busy = true
        scope.launch {
            try {
                val out = app.client.callProved("threads.answer", input("ask" to id, "decision" to decision, "surface" to "android"),
                    (if (decision == "allow") "Allow: " else "Deny: ") + summary)
                if (out.str("answered") == "false") note = out.str("note") ?: "Already answered."
                else { if (decision == "allow") haptic(); onDone() }
            } catch (e: ApiError.Cancelled) { } catch (e: Exception) { note = e.plain() }
            busy = false
        }
    }
    Column(
        Modifier.fillMaxWidth().padding(vertical = 4.dp).clip(RoundedCornerShape(Radius.panel)).background(c.beaconWash).padding(horizontal = Space.l, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Dot(c.beaconDot); Spacer(Modifier.width(Space.s)); Label("Permission", Modifier.weight(1f), c.beaconInk)
            Text(listOfNotNull(agent, ago(ask.str("at")?.toLongOrNull()).takeIf { it.isNotEmpty() }).joinToString(" · "), style = Type.monoSmall, color = c.text2)
        }
        Text(buildAnnotatedString {
            withStyle(SpanStyle(fontFamily = Type.bodyStrong.fontFamily, fontWeight = Type.bodyStrong.fontWeight)) { append("May I run ") }
            withStyle(SpanStyle(fontFamily = Type.code.fontFamily)) { append(summary) }
        }, style = Type.body, color = c.text)
        ask.str("destination")?.let { Text(it, style = Type.monoSmall, color = c.text2) }
        ask.str("reason")?.let { Text(it, style = Type.small, color = c.text2) }
        val decided = ask.str("decision")
        if (decided != null && decided != "null") Label(decided)
        else Row(horizontalArrangement = Arrangement.spacedBy(Space.s), modifier = Modifier.padding(top = Space.s)) {
            VButton("Allow", onClick = { answer("allow") }, kind = ButtonKind.Primary, enabled = !busy, modifier = Modifier.weight(1f).semantics { onClick("Allow $summary") { answer("allow"); true } })
            VButton("Deny", onClick = { answer("deny") }, enabled = !busy, modifier = Modifier.weight(1f))
        }
        note?.let { Text(it, style = Type.small, color = c.text2) }
    }
}
