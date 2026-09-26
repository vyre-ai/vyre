package sh.vyre.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import sh.vyre.app.api.ApiError
import sh.vyre.app.api.input
import sh.vyre.app.api.plain
import sh.vyre.app.api.str
import sh.vyre.app.design.ButtonKind
import sh.vyre.app.design.Chip
import sh.vyre.app.design.Label
import sh.vyre.app.design.SectionHead
import sh.vyre.app.design.Space
import sh.vyre.app.design.ThemeChoice
import sh.vyre.app.design.Type
import sh.vyre.app.design.V
import sh.vyre.app.design.VButton
import sh.vyre.app.presence.SignIn
import sh.vyre.app.push.PushRegistration

/** Settings: theme, the box, this phone's key, notifications, sign out. */
@Composable
fun SettingsScreen(onBack: () -> Unit) {
    val app = LocalApp.current
    val activity = LocalActivity.current
    val scope = rememberCoroutineScope()
    val theme by app.prefs.theme.collectAsState()
    val address by app.prefs.address.collectAsState()
    val keyId by app.prefs.keyId.collectAsState()
    val connected by app.stream.connected.collectAsState()
    val health = rememberLoad("health") { app.client.health() }
    var push by remember { mutableStateOf<String?>(null) }
    var out by remember { mutableStateOf<String?>(null) }
    var offerLocal by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    val c = V.c

    fun signOut() {
        busy = true; out = null
        scope.launch {
            try {
                // The box forgets this phone's key first (ADR 0018 section 6), then the phone forgets everything.
                keyId?.let { app.client.callProved("presence.remove", input("id" to it), "Sign this phone out of the box") }
                runCatching { PushRegistration.device(activity)?.let { d -> app.client.call("push.unsubscribe", input("device" to d)) } }
                app.wipe()
            } catch (e: ApiError.Cancelled) {
            } catch (e: Exception) {
                out = "The box did not forget this phone: ${e.plain()}"
                offerLocal = true
            }
            busy = false
        }
    }

    Page(top = { BackBar("More", onBack) }) {
        item { Text("Settings", style = Type.h2, color = c.text) }

        item {
            SectionHead("Theme")
            Row(horizontalArrangement = Arrangement.spacedBy(Space.s)) {
                for (t in ThemeChoice.entries) Chip(when (t) { ThemeChoice.System -> "Like the phone"; ThemeChoice.Dark -> "Dark"; ThemeChoice.Paper -> "Paper" },
                    onClick = { app.prefs.setTheme(t) }, selected = theme == t)
            }
        }

        item {
            SectionHead("Box", if (connected) "live" else "not live", rightColor = if (connected) c.focus else c.label)
            Text(address?.substringAfter("://") ?: "none", style = Type.code, color = c.text)
            val h = health.v.value
            Text(when {
                h != null -> dots("version ${h.str("version") ?: "?"}", h.str("role"), h.str("uptime")?.toDoubleOrNull()?.let { "up ${(it / 3600).toInt()} h" })
                health.v.error != null -> health.v.error!!.plain()
                else -> "Checking"
            }, style = Type.monoSmall, color = c.secondary, modifier = Modifier.padding(top = 4.dp))
            Text("To use another box, sign out and sign in there.", style = Type.small, color = c.secondary, modifier = Modifier.padding(top = Space.s))
        }

        item {
            SectionHead("This phone")
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(SignIn.deviceName(), style = Type.body, color = c.text)
                Text(dots("key ${keyId ?: "none"}", app.key.hardware()), style = Type.monoSmall, color = c.secondary)
                app.key.canAuthenticate()?.let { Text(it, style = Type.small, color = c.beacon) }
                Text("Approving, answering and the vault need your fingerprint and this key. It never leaves the phone.", style = Type.small, color = c.secondary)
            }
        }

        item {
            SectionHead("Notifications")
            Text(PushRegistration.device(activity)?.let { "On, as device $it." } ?: "Off.", style = Type.small, color = c.secondary)
            VButton("Turn on", onClick = { scope.launch { push = PushRegistration.subscribe(activity, app.client) ?: "On." } }, modifier = Modifier.padding(top = Space.s))
            push?.let { Quiet(it) }
        }

        item {
            SectionHead("Sign out")
            Text("The box forgets this phone's key; this phone forgets the key, the box address and what it kept.", style = Type.small, color = c.secondary)
            Row(horizontalArrangement = Arrangement.spacedBy(Space.s), modifier = Modifier.padding(top = Space.s)) {
                VButton(if (busy) "Signing out" else "Sign out", onClick = { signOut() }, enabled = !busy, kind = ButtonKind.Beacon)
                if (offerLocal) VButton("Forget on this phone only", onClick = { app.wipe() }, kind = ButtonKind.Quiet)
            }
            out?.let { Quiet(it) }
        }

        item {
            SectionHead("About")
            Label("Vyre for Android ${sh.vyre.app.BuildConfig.VERSION_NAME}")
            Text("Instrument Sans and JetBrains Mono, both under the SIL Open Font License.", style = Type.small, color = c.secondary, modifier = Modifier.padding(top = 4.dp))
        }
    }
}
