package sh.vyre.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import sh.vyre.app.api.arr
import sh.vyre.app.api.at
import sh.vyre.app.api.double
import sh.vyre.app.api.input
import sh.vyre.app.api.long
import sh.vyre.app.api.obj
import sh.vyre.app.api.plain
import sh.vyre.app.api.str
import sh.vyre.app.api.strings
import sh.vyre.app.data.ago
import sh.vyre.app.data.money
import sh.vyre.app.design.ButtonKind
import sh.vyre.app.design.Dot
import sh.vyre.app.design.Label
import sh.vyre.app.design.SectionHead
import sh.vyre.app.design.Space
import sh.vyre.app.design.Type
import sh.vyre.app.design.V
import sh.vyre.app.design.VButton

// ---- Agents (CONTRACT.md 4.1) ----

/** Agents (a tab, as in the PWA): the assistant first, then the agents; each opens its page. */
@Composable
fun AgentsScreen() {
    val app = LocalApp.current
    val nav = LocalNav.current
    val load = rememberLoad("agents") { app.client.call("agents.list").arr.toList() }
    OnEvents("thread.started", "thread.finished", "thread.stopped", "ask.raised", "ask.answered") { load.refresh() }
    val list = load.v.value.orEmpty()
    Page(top = { BrandBar() }) {
        item { Text("Agents", style = Type.h1, color = V.c.text, modifier = Modifier.padding(top = Space.s)) }
        item { SectionHead("Agents · ${list.size}") }
        loadState(load.v, list.isEmpty(), "No agents on this box yet.")
        items(list, key = { "a" + it.str("name") }) { a ->
            val doing = a.str("doing")
            Row2(a.str("name").orEmpty(), dots(if (a.str("kind") == "assistant") "assistant" else null, doing, a.str("model")),
                subColor = if (doing == "waiting on your answer") V.c.beacon else null,
                leading = { Dot(when (doing) { "working", "starting" -> V.c.focus; "waiting on your answer" -> V.c.beaconDot; else -> V.c.label }) },
                onClick = { nav("agent/" + android.net.Uri.encode(a.str("name").orEmpty())) })
        }
    }
}

/** One agent: what it is doing, its spend, its sessions, and a line to ask it something. */
@Composable
fun AgentScreen(name: String, back: String, onBack: () -> Unit) {
    val app = LocalApp.current
    val nav = LocalNav.current
    val scope = rememberCoroutineScope()
    val agent = rememberLoad("agent", name) { app.client.call("agents.list").arr.firstOrNull { it.str("name") == name } }
    val usage = rememberLoad("usage", name) { runCatching { app.client.call("agents.usage", input("agent" to name)).arr.firstOrNull { it.str("agent") == name } }.getOrNull() }
    val threads = rememberLoad("agent-threads", name) { app.client.call("agents.threads", input("agent" to name)).arr.toList() }
    OnEvents("thread.started", "thread.finished", "thread.stopped") { agent.refresh(); threads.refresh() }
    var text by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var note by remember { mutableStateOf<String?>(null) }
    val a = agent.v.value
    val u = usage.v.value
    val c = V.c
    val running = threads.v.value.orEmpty().any { it.str("status") != "stopped" && it.str("status") != "idle" }

    Page(top = { BackBar(back, onBack) }) {
        item {
            Text(name, style = Type.h2, color = c.text)
            Text(dots(a.str("kind"), a.str("doing"), a.str("model"), a.str("auth")), style = Type.monoSmall, color = c.secondary, modifier = Modifier.padding(top = 4.dp))
            if (agent.v.error != null) Quiet(agent.v.error!!.plain(), "failed")
            val projects = a.strings("projects")
            val scopeLine = if (projects == listOf("*")) "Every project" else projects.joinToString(", ").ifEmpty { null }
            scopeLine?.let { Text(it, style = Type.small, color = c.secondary, modifier = Modifier.padding(top = 2.dp)) }
        }
        if (u != null) item {
            SectionHead("Spend")
            Row(horizontalArrangement = Arrangement.spacedBy(Space.xl)) {
                Stat("Spent", money(u.double("spent_usd") ?: u.double("cost_usd")))
                u.double("left_usd")?.let { Stat("Left", money(it)) }
                Stat("Turns", (u.long("turns") ?: 0).toString())
            }
            u.at("limit")?.obj?.let { l -> l.str("status")?.let { s -> Quiet("Limit: " + dots(s, l.str("kind"))) } }
        }
        item {
            SectionHead("Ask $name")
            Composer(text, { text = it }, placeholder = "What should $name do?", busy = busy, onSend = {
                busy = true; note = null
                scope.launch {
                    try {
                        val out = app.client.call("agents.ask", input("agent" to name, "text" to text.trim(), "surface" to SURFACE, "wait" to false), timeoutSec = 60)
                        if (out.str("ok") == "false") note = out.str("note") ?: "$name did not take it."
                        else { text = ""; out.str("thread")?.let { nav("thread/$it") } }
                    } catch (e: Exception) { note = e.plain() }
                    busy = false
                }
            })
            note?.let { Quiet(it) }
            if (running) VButton("Stop $name", kind = ButtonKind.Quiet, modifier = Modifier.padding(top = Space.s), onClick = {
                scope.launch {
                    note = try { val out = app.client.call("agents.stop", input("agent" to name)); "Stopped ${out.at("stopped").arr.size} session(s)." } catch (e: Exception) { e.plain() }
                    threads.refresh(); agent.refresh()
                }
            })
        }
        item { SectionHead("Sessions · ${threads.v.value?.size ?: 0}") }
        loadState(threads.v, threads.v.value.isNullOrEmpty(), "$name has no session in the last day.")
        items(threads.v.value.orEmpty(), key = { "t" + it.str("id") }) { t ->
            Row2(label(t), dots(t.str("project"), t.str("status"), ago(t.str("last")?.toLongOrNull())), onClick = { nav("thread/${t.str("id")}") })
        }
    }
}

@Composable
private fun Stat(label: String, value: String) {
    Column {
        Label(label)
        Text(value.ifEmpty { "0" }, style = Type.hero, color = V.c.text, modifier = Modifier.padding(top = 2.dp))
    }
}

// ---- Memory (CONTRACT.md 4.2: the phone may read facts and why, and pin or mute) ----

@Composable
fun MemoryScreen(start: String, back: String, onBack: () -> Unit) {
    val app = LocalApp.current
    val nav = LocalNav.current
    var q by rememberSaveable { mutableStateOf(start) }
    var about by rememberSaveable { mutableStateOf(start) }
    val load = rememberLoad("facts", about) {
        app.client.call("memory.facts", if (about.isBlank()) input("limit" to 100) else input("about" to about.trim(), "limit" to 100))
    }
    OnEvents("memory.curated") { load.refresh() }
    val facts = load.v.value.at("facts").arr
    val node = load.v.value.at("about")
    val c = V.c
    Page(top = {
        BackBar(back, onBack)
        Text("Memory", style = Type.h2, color = c.text, modifier = Modifier.padding(bottom = Space.m))
        InputBox(q, { q = it; if (it.isBlank()) about = "" }, "About someone or something: Harlow Legal, juno", imeAction = ImeAction.Search, onGo = { about = q })
    }) {
        if (node != null) item {
            SectionHead(node.str("label") ?: about, dots(node.str("kind"), node.str("age")))
            Text(dots(node.long("sessions")?.let { "$it sessions" }, node.long("mentions")?.let { "$it mentions" }, if (node.str("pinned") == "true") "pinned" else null, if (node.str("muted") == "true") "muted" else null),
                style = Type.monoSmall, color = c.secondary)
        } else item { SectionHead(if (about.isBlank()) "Recent · ${facts.size}" else "About $about · ${facts.size}") }
        loadState(load.v, facts.isEmpty(), if (about.isBlank()) "Nothing learned yet." else "Nothing is known about \"$about\".")
        items(facts, key = { "f" + it.str("id") }) { f ->
            Row2(f.str("text").orEmpty(), dots(f.str("age"), f.double("confidence")?.let { "${(it * 100).toInt()}%" }, f.str("source"), if (f.str("conflict") == "true") "conflict" else null, if (f.str("stale") == "true") "stale" else null),
                subColor = if (f.str("conflict") == "true") c.recall else null,
                onClick = { f.str("id")?.let { nav("fact/" + android.net.Uri.encode(it)) } })
        }
    }
}

/** One fact: where it came from (memory.why), and pin or mute its subject. */
@Composable
fun FactScreen(id: String, back: String, onBack: () -> Unit) {
    val app = LocalApp.current
    val scope = rememberCoroutineScope()
    val load = rememberLoad("why", id) { app.client.call("memory.why", input("fact" to id, "limit" to 10)) }
    var note by remember { mutableStateOf<String?>(null) }
    val w = load.v.value
    val f = w.at("fact")
    val turns = w.at("turns").arr
    val taught = w.at("taught").arr
    val subject = f.at("subject")
    val c = V.c
    fun mark(tool: String, node: String, off: Boolean) {
        scope.launch {
            note = try {
                val out = app.client.call(tool, input("node" to node, "off" to off.takeIf { it }))
                when (out.str("mode")) { "pin" -> "Pinned ${out.str("label")}."; "mute" -> "Muted ${out.str("label")}."; else -> "Cleared ${out.str("label")}." }
            } catch (e: Exception) { e.plain() }
        }
    }
    Page(top = { BackBar(back, onBack) }) {
        item {
            Text(f.str("text") ?: id, style = Type.h3, color = c.text)
            Text(dots(f.str("age"), f.double("confidence")?.let { "${(it * 100).toInt()}% sure" }, f.str("origin"), f.long("evidence")?.let { "$it sources" }),
                style = Type.monoSmall, color = c.secondary, modifier = Modifier.padding(top = 4.dp))
            if (load.v.error != null) Quiet(load.v.error!!.plain(), "failed")
        }
        val sid = subject.str("id")
        if (sid != null) item {
            SectionHead("About ${subject.str("label") ?: sid}")
            Row(horizontalArrangement = Arrangement.spacedBy(Space.s)) {
                VButton("Pin", onClick = { mark("memory.pin", sid, false) })
                VButton("Mute", onClick = { mark("memory.mute", sid, false) })
                VButton("Clear", kind = ButtonKind.Quiet, onClick = { mark("memory.pin", sid, true) })
            }
            note?.let { Quiet(it) }
        }
        item { SectionHead("Where it came from · ${turns.size}") }
        if (w != null && turns.isEmpty() && taught.isEmpty()) item { Quiet("No turn is left that says it${if ((w.long("gone") ?: 0) > 0) "; ${w.long("gone")} are gone" else ""}.") }
        items(turns, key = { "t" + it.str("session") + it.str("seq") }) { t ->
            Column(Modifier.padding(vertical = Space.s)) {
                Label(dots(t.str("name"), t.str("role"), t.str("age")))
                Text(t.str("text").orEmpty(), style = Type.small, color = c.text, modifier = Modifier.padding(top = 4.dp))
            }
        }
        if (taught.isNotEmpty()) {
            item { SectionHead("Taught by modules · ${taught.size}") }
            items(taught, key = { "m" + it.str("module") + it.str("key") + it.str("at") }) { t ->
                Row2(t.str("text").orEmpty(), dots(t.str("module"), t.str("kind"), t.str("age")))
            }
        }
    }
}
