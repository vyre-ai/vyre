package sh.vyre.app.ui

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.PersistableBundle
import android.view.WindowManager
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.DisableSelection
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import sh.vyre.app.api.ApiError
import sh.vyre.app.api.PresenceSession
import sh.vyre.app.api.arr
import sh.vyre.app.api.at
import sh.vyre.app.api.bool
import sh.vyre.app.api.input
import sh.vyre.app.api.long
import sh.vyre.app.api.plain
import sh.vyre.app.api.str
import sh.vyre.app.api.strings
import sh.vyre.app.design.ButtonKind
import sh.vyre.app.design.Hairline
import sh.vyre.app.design.Label
import sh.vyre.app.design.Radius
import sh.vyre.app.design.SectionHead
import sh.vyre.app.design.Space
import sh.vyre.app.design.Type
import sh.vyre.app.design.V
import sh.vyre.app.design.VButton

/**
 * The Vault (ADR 0018 section 7): vault.list shows names, kinds and hosts, never a value. A value
 * appears only after a device proof for that item, conceals itself after `concealAfter` seconds
 * and when the app leaves the screen, and the window is FLAG_SECURE while one shows.
 */
@Composable
fun VaultScreen(back: String, onBack: () -> Unit) {
    val app = LocalApp.current
    val nav = LocalNav.current
    val scope = rememberCoroutineScope()
    val load = rememberLoad("vault") { app.client.call("vault.list") }
    var filter by rememberSaveable { mutableStateOf("") }
    var session by remember { mutableStateOf(app.client.presenceSession?.takeIf { it.live() }) }
    var note by remember { mutableStateOf<String?>(null) }
    val tick = rememberTick(15_000)
    val v = load.v.value
    val rows = v.at("items").arr.filter { filter.isBlank() || it.str("name").orEmpty().contains(filter.trim(), true) || it.strings("hosts").any { h -> h.contains(filter.trim(), true) } }
    val c = V.c

    fun openSession() {
        scope.launch {
            try {
                val out = app.client.callProved("presence.session.open", input(), "Keep the vault open on this phone for 5 minutes")
                val s = PresenceSession(out.str("session")!!, out.str("secret")!!, out.long("expires") ?: (System.currentTimeMillis() + 30 * 60_000), out.long("idle") ?: 300_000)
                app.client.presenceSession = s; session = s; note = null
            } catch (e: ApiError.Cancelled) { } catch (e: Exception) { note = e.plain() }
        }
    }
    fun closeSession() {
        val s = session ?: return
        app.client.presenceSession = null; session = null
        scope.launch { runCatching { app.client.call("presence.session.close", input("session" to s.id)) } }
    }

    Page(top = {
        BackBar(back, onBack)
        Text("Vault", style = Type.h2, color = c.text, modifier = Modifier.padding(bottom = Space.m))
        InputBox(filter, { filter = it }, "Filter by name or host", imeAction = ImeAction.Search)
    }) {
        item {
            SectionHead("This phone")
            val live = session?.takeIf { tick >= 0 && it.live() }
            if (live != null) {
                val left = ((live.lastUsed + live.idleMs - System.currentTimeMillis()) / 60_000).coerceAtLeast(0)
                Text("Open: reveals need no fingerprint for about ${left + 1} min more, or until you close it.", style = Type.small, color = c.text2)
                VButton("Close now", onClick = { closeSession() }, modifier = Modifier.padding(top = Space.s))
            } else {
                Text("Each value needs your fingerprint. To reveal several in a row, keep the vault open for 5 minutes.", style = Type.small, color = c.text2)
                VButton("Keep open 5 min", onClick = { openSession() }, modifier = Modifier.padding(top = Space.s))
            }
            note?.let { Quiet(it) }
        }
        if (v.bool("locked") == true) item { Quiet("The vault on the box is locked. Unlock it from the Mac or the Deck, then pull to refresh.", "locked") }
        item { SectionHead("Items · ${rows.size}", v.str("personal")?.takeIf { it != "none" }?.let { "personal $it" }) }
        loadState(load.v, rows.isEmpty(), if (filter.isBlank()) "Nothing in the vault yet." else "Nothing matches \"$filter\".")
        items(rows, key = { "v" + it.str("vault") + it.str("name") }) { it2 ->
            Row2(it2.str("name").orEmpty(), dots(it2.str("kind"), it2.strings("hosts").firstOrNull(), if (it2.bool("stale") == true) "stale" else null),
                subColor = if (it2.bool("stale") == true) c.recall else null,
                onClick = { nav("vault/" + android.net.Uri.encode(it2.str("name").orEmpty())) })
        }
    }
}

private class Shown(val value: String, val until: Long)

@Composable
fun VaultItemScreen(name: String, onBack: () -> Unit) {
    val app = LocalApp.current
    val activity = LocalActivity.current
    val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current
    val load = rememberLoad("vault-item", name) { app.client.call("vault.item", input("name" to name)).at("item") }
    val shown = remember(name) { mutableStateMapOf<String, Shown>() }
    var totp by remember(name) { mutableStateOf<Shown?>(null) }
    var note by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf<String?>(null) }
    val rec = load.v.value
    val c = V.c
    val showing = shown.isNotEmpty() || totp != null

    // FLAG_SECURE while any value is on screen: no screenshots, a blank thumbnail in Recents.
    DisposableEffect(showing) {
        if (showing) activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        onDispose { activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE) }
    }
    // Leaving the screen conceals everything.
    DisposableEffect(lifecycle) {
        val obs = LifecycleEventObserver { _, e -> if (e == Lifecycle.Event.ON_STOP) { shown.clear(); totp = null } }
        lifecycle.lifecycle.addObserver(obs)
        onDispose { lifecycle.lifecycle.removeObserver(obs); shown.clear(); totp = null }
    }
    // Each value conceals itself when its time is up.
    val tick = rememberTick(1000)
    LaunchedEffect(tick) {
        val now = System.currentTimeMillis()
        shown.entries.filter { e -> e.value.until <= now }.map { e -> e.key }.forEach { k -> shown.remove(k) }
        if ((totp?.until ?: Long.MAX_VALUE) <= now) totp = null
    }

    fun reveal(field: String?, copy: Boolean) {
        busy = field ?: ""; note = null
        scope.launch {
            try {
                val label = field ?: "the value"
                val out = app.client.callVault("vault.reveal", input("name" to name, "field" to field), (if (copy) "Copy " else "Reveal ") + "$label of $name")
                val value = out.str("value").orEmpty()
                val secs = out.long("concealAfter") ?: 30
                if (copy) { copySensitive(activity, value, secs, app); note = "Copied. The clipboard clears in $secs s." }
                else shown[field ?: ""] = Shown(value, System.currentTimeMillis() + secs * 1000)
            } catch (e: ApiError.Cancelled) { } catch (e: Exception) { note = e.plain() }
            busy = null
        }
    }
    fun code() {
        busy = "totp"; note = null
        scope.launch {
            try {
                val out = app.client.callVault("vault.totp", input("name" to name), "One-time code for $name")
                totp = Shown(out.str("code").orEmpty(), System.currentTimeMillis() + (out.long("remaining") ?: 30) * 1000)
            } catch (e: ApiError.Cancelled) { } catch (e: Exception) { note = e.plain() }
            busy = null
        }
    }

    Page(top = { BackBar("Vault", onBack) }) {
        item {
            Text(name, style = Type.h2, color = c.text)
            Text(dots(rec.str("kind"), rec.str("vault"), rec.str("updated")?.let { u -> u.toLongOrNull()?.let { ms -> sh.vyre.app.data.ago(ms) + " ago" } ?: u }),
                style = Type.monoSmall, color = c.text2, modifier = Modifier.padding(top = 4.dp))
            rec.str("description")?.let { d -> Text(d, style = Type.small, color = c.text2, modifier = Modifier.padding(top = Space.s)) }
            if (load.v.error != null) Quiet(load.v.error!!.plain(), "failed")
            if (load.v.loading && rec == null) Quiet("Loading")
        }
        if (rec != null) {
            val fields = rec.strings("fields").ifEmpty { listOf("") }
            item { SectionHead("Fields · ${fields.size}", "fingerprint each") }
            items(fields, key = { f -> "f$f" }) { f ->
                val s = shown[f]
                val left = s?.let { x -> ((x.until - System.currentTimeMillis()) / 1000).coerceAtLeast(0) }
                Column(Modifier.fillMaxWidth().padding(vertical = Space.s)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Label(f.ifEmpty { "value" }, Modifier.weight(1f))
                        if (left != null && tick >= 0) Label("hides in $left s")
                    }
                    DisableSelection {
                        Text(s?.value ?: "•".repeat(10), style = Type.code, color = if (s != null) c.text else c.label,
                            modifier = Modifier.fillMaxWidth().padding(top = 6.dp).clip(RoundedCornerShape(Radius.button)).background(c.panel).padding(Space.m))
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(Space.s), modifier = Modifier.padding(top = Space.s)) {
                        if (s == null) VButton("Reveal", onClick = { reveal(f.ifEmpty { null }, false) }, enabled = busy == null)
                        else VButton("Hide", onClick = { shown.remove(f) })
                        VButton("Copy", onClick = { reveal(f.ifEmpty { null }, true) }, kind = ButtonKind.Ghost, enabled = busy == null)
                    }
                }
                Hairline()
            }
            if (rec.bool("otp") == true) item {
                SectionHead("One-time code")
                val t = totp
                if (t != null) Text(t.value.chunked(3).joinToString(" "), style = Type.hero, color = c.text)
                VButton(if (t == null) "Show code" else "New code", onClick = { code() }, enabled = busy == null, modifier = Modifier.padding(top = Space.s))
            }
            val hosts = rec.strings("hosts")
            if (hosts.isNotEmpty() || rec.str("url") != null) item {
                SectionHead("Used on")
                Text((listOfNotNull(rec.str("url")) + hosts).distinct().joinToString("\n"), style = Type.monoSmall, color = c.text2)
            }
            val grants = rec.at("grants").arr
            if (grants.isNotEmpty()) item {
                SectionHead("Granted to · ${grants.size}")
                Text(grants.joinToString("\n") { g -> dots(g.str("module"), g.str("watcher")) }, style = Type.monoSmall, color = c.text2)
            }
        }
        note?.let { n -> item { Quiet(n) } }
    }
}

/**
 * The phone's own clipboard, never the box's (vault.copy copies there): marked sensitive so the
 * keyboard and the clipboard preview do not show it, and cleared after `secs` if it is still ours.
 */
private fun copySensitive(context: Context, value: String, secs: Long, app: sh.vyre.app.VyreApp) {
    val cm = context.getSystemService(ClipboardManager::class.java) ?: return
    val clip = ClipData.newPlainText(CLIP_LABEL, value)
    clip.description.extras = PersistableBundle().apply {
        putBoolean(if (Build.VERSION.SDK_INT >= 33) ClipDescription.EXTRA_IS_SENSITIVE else "android.content.extra.IS_SENSITIVE", true)
    }
    cm.setPrimaryClip(clip)
    app.scope.launch(kotlinx.coroutines.Dispatchers.Main) {
        delay(secs * 1000)
        runCatching {
            if (cm.primaryClipDescription?.label == CLIP_LABEL) {
                if (Build.VERSION.SDK_INT >= 28) cm.clearPrimaryClip() else cm.setPrimaryClip(ClipData.newPlainText("", ""))
            }
        }
    }
}

private const val CLIP_LABEL = "Vyre"
