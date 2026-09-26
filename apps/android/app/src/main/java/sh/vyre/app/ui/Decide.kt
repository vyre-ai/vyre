package sh.vyre.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import sh.vyre.app.VyreApp
import sh.vyre.app.api.ApiError
import sh.vyre.app.api.input
import sh.vyre.app.api.plain
import sh.vyre.app.api.str
import sh.vyre.app.data.Held
import sh.vyre.app.design.ButtonKind
import sh.vyre.app.design.Label
import sh.vyre.app.design.Space
import sh.vyre.app.design.Type
import sh.vyre.app.design.V
import sh.vyre.app.design.VButton

/** What waits for the person's yes before a proof is asked for. */
sealed class Confirm {
    /** A held item's final words, whole; `shown` is Held.shown of what is on screen. */
    data class Send(val item: JsonElement, val shown: String, val changed: Boolean = false) : Confirm()
    /** A session asking to run something: its full summary, where and why. */
    data class Allow(val ask: JsonElement) : Confirm()
}

/**
 * Approve, discard, allow and deny from anywhere (a swipe on Now, the coming detail sheet), each
 * signed with the device key behind the fingerprint sheet.
 *
 * Floor rule 1: nothing goes out as the user until the user has seen the final words. So a swipe
 * to send never sends from the swipe: it reads the item (gate.get), shows its destination and
 * every field of the final content, and only on Send asks for the proof. After the proof it reads
 * the item again and sends only if what was shown is unchanged; a revision that landed meanwhile
 * is shown instead, and nothing goes. Discard and Deny send nothing out, so they go straight to
 * the proof, whose reason names the item.
 */
class Decider(private val app: VyreApp, private val scope: CoroutineScope, val pending: MutableState<Confirm?>, val note: MutableState<String?>, private val done: () -> Unit) {
    fun approve(id: String) {
        note.value = null
        scope.launch {
            try {
                val item = app.client.call("gate.get", input("id" to id))
                if (item.str("state") != "held") { note.value = "It is already ${item.str("state")}."; done(); return@launch }
                pending.value = Confirm.Send(item, Held.shown(item))
            } catch (e: Exception) { note.value = e.plain() }
        }
    }

    fun send(c: Confirm.Send) {
        pending.value = null
        val id = c.item.str("id") ?: return
        val tool = "gate.approve"
        val body = input("id" to id)
        scope.launch {
            try {
                val prover = app.client.prover ?: throw ApiError.PresenceRequired("This phone has no device key yet", listOf("device"))
                val header = prover.header(tool, body, Held.reason(c.item, Held.action(c.item.str("kind"))))
                // What was shown must still be what goes.
                val now = app.client.call("gate.get", input("id" to id))
                if (Held.shown(now) != c.shown) {
                    pending.value = if (now.str("state") == "held") Confirm.Send(now, Held.shown(now), changed = true) else null
                    note.value = if (now.str("state") == "held") "It changed while you read it. Nothing was sent; read it again." else "It is already ${now.str("state")}."
                    return@launch
                }
                val out = app.client.call(tool, body, header, 60)
                note.value = if (out.str("state") == "failed") "Held again: ${out.str("error") ?: "the send failed"}" else null
                done()
            } catch (e: ApiError.Cancelled) {
            } catch (e: Exception) { note.value = e.plain() }
        }
    }

    fun reject(brief: JsonElement) {
        val id = brief.str("id") ?: return
        note.value = null
        scope.launch {
            try { app.client.callProved("gate.reject", input("id" to id), Held.reason(brief, "Discard")); done() }
            catch (e: ApiError.Cancelled) { } catch (e: Exception) { note.value = e.plain() }
        }
    }

    /** Allow shows the ask whole first; Deny goes to the proof. */
    fun answer(ask: JsonElement, decision: String) {
        note.value = null
        if (decision == "allow") { pending.value = Confirm.Allow(ask); return }
        prove(ask, "deny")
    }

    fun allow(c: Confirm.Allow) { pending.value = null; prove(c.ask, "allow") }

    private fun prove(ask: JsonElement, decision: String) {
        val id = ask.str("id") ?: ask.str("ask") ?: return
        val summary = ask.str("summary").orEmpty()
        scope.launch {
            try {
                val out = app.client.callProved("threads.answer", input("ask" to id, "decision" to decision, "surface" to SURFACE),
                    (if (decision == "allow") "Allow: " else "Deny: ") + summary)
                if (out.str("answered") == "false") note.value = out.str("note") ?: "Already answered."
                done()
            } catch (e: ApiError.Cancelled) { } catch (e: Exception) { note.value = e.plain() }
        }
    }
}

@Composable
fun rememberDecider(done: () -> Unit): Decider {
    val app = LocalApp.current
    val scope = rememberCoroutineScope()
    val pending = remember { mutableStateOf<Confirm?>(null) }
    val note = remember { mutableStateOf<String?>(null) }
    return remember { Decider(app, scope, pending, note) { done() } }
}

/**
 * The final words before a proof. A plain dialog for now: the Direction B detail sheet
 * (docs/design/phone.md) replaces its look, not what it shows or when.
 */
@Composable
fun ConfirmDialog(d: Decider) {
    val c = V.c
    when (val p = d.pending.value) {
        null -> {}
        is Confirm.Send -> {
            val verb = Held.action(p.item.str("kind"))
            AlertDialog(
                onDismissRequest = { d.pending.value = null },
                containerColor = c.panel,
                title = { Text(Held.title(p.item), style = Type.h3, color = c.text) },
                text = {
                    Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(Space.m)) {
                        if (p.changed) Text("It changed while you read it. This is the new version.", style = Type.small, color = c.beaconInk)
                        for (f in Held.finalWords(p.item)) Column {
                            Label(if (f.key == "to") "Goes to" else f.label)
                            Text(f.original.ifEmpty { " " }, style = if (f.json || f.key == "url" || f.key == "method") Type.code else Type.body, color = c.text, modifier = Modifier.padding(top = 4.dp))
                        }
                    }
                },
                confirmButton = { VButton(verb, onClick = { d.send(p) }, kind = ButtonKind.Primary) },
                dismissButton = { VButton("Not now", onClick = { d.pending.value = null }, kind = ButtonKind.Quiet) },
            )
        }
        is Confirm.Allow -> {
            val a = p.ask
            AlertDialog(
                onDismissRequest = { d.pending.value = null },
                containerColor = c.panel,
                title = { Text("Allow this?", style = Type.h3, color = c.text) },
                text = {
                    Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(Space.m)) {
                        Column { Label(a.str("tool") ?: "Runs"); Text(a.str("summary").orEmpty(), style = Type.code, color = c.text, modifier = Modifier.padding(top = 4.dp)) }
                        a.str("destination")?.let { Column { Label("Where"); Text(it, style = Type.code, color = c.text, modifier = Modifier.padding(top = 4.dp)) } }
                        a.str("reason")?.let { Column { Label("Why"); Text(it, style = Type.body, color = c.text2, modifier = Modifier.padding(top = 4.dp)) } }
                    }
                },
                confirmButton = { VButton("Allow", onClick = { d.allow(p) }, kind = ButtonKind.Primary) },
                dismissButton = { VButton("Not now", onClick = { d.pending.value = null }, kind = ButtonKind.Quiet) },
            )
        }
    }
}

/** A line under the list when a decision could not go through. */
@Composable
fun DecideNote(d: Decider) {
    d.note.value?.let { Row(Modifier.fillMaxWidth()) { Quiet(it) } }
}
