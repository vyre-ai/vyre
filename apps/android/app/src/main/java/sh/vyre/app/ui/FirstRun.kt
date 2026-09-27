package sh.vyre.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import kotlinx.coroutines.launch
import sh.vyre.app.BuildConfig
import sh.vyre.app.api.ApiError
import sh.vyre.app.api.Client
import sh.vyre.app.api.plain
import sh.vyre.app.api.str
import sh.vyre.app.data.Links
import sh.vyre.app.design.ButtonKind
import sh.vyre.app.design.Hairline
import sh.vyre.app.design.Label
import sh.vyre.app.design.Space
import sh.vyre.app.design.Type
import sh.vyre.app.design.V
import sh.vyre.app.design.VButton
import sh.vyre.app.presence.SignIn

/**
 * First run: find the box (its address), check it answers, then sign in: this phone makes a
 * device key and the box's own /onboard/device page, in a Custom Tab, approves it with the Deck's
 * passkey (or the one-time code) and comes back on vyre://enrolled?id=<key id>.
 * Debug builds also offer the test world at BuildConfig.DEFAULT_ADDRESS, enrolled with a code
 * from its POST /__test/code.
 */
@Composable
fun FirstRun() {
    val app = LocalApp.current
    val activity = LocalActivity.current
    val scope = rememberCoroutineScope()
    val saved by app.prefs.address.collectAsState()
    var typed by rememberSaveable { mutableStateOf(saved?.removePrefix("https://").orEmpty()) }
    var busy by remember { mutableStateOf(false) }
    var line by rememberSaveable { mutableStateOf<String?>(null) }
    var waiting by rememberSaveable { mutableStateOf(false) }
    val c = V.c

    fun fail(e: Throwable, address: String) {
        line = when (e) {
            is ApiError.Offline -> "Could not reach ${address.substringAfter("://")}. Is Tailscale connected on this phone?"
            is ApiError.Cancelled -> "Sign-in cancelled. Nothing was enrolled."
            is IllegalStateException, is java.security.GeneralSecurityException, is java.security.ProviderException ->
                "This phone could not make its key: ${e.message ?: "set a screen lock and a fingerprint first"}."
            else -> e.plain()
        }
    }

    fun signIn() {
        if (busy) return
        val address = Links.address(typed) ?: run { line = "That is not a box address. It looks like vyre.your-tailnet.ts.net."; return }
        busy = true
        scope.launch {
            try {
                line = "Looking for ${address.substringAfter("://")}."
                Client({ address }).health()
                app.key.canAuthenticate()?.let { line = it; busy = false; return@launch }
                val pub = app.key.create()
                // The address is kept now; the key id only once the box has enrolled it.
                app.prefs.setAddress(address)
                waiting = true
                line = "Found it. Approve this phone on the page that opened, with your passkey or the code from vyre presence code."
                SignIn.open(activity, address, pub, SignIn.deviceName())
            } catch (e: Exception) { fail(e, address) }
            busy = false
        }
    }

    fun testWorld(address: String) {
        if (busy) return
        busy = true
        scope.launch {
            try {
                line = "Test world: looking for $address."
                val probe = Client({ address })
                probe.health()
                val code = probe.post("/__test/code").str("code") ?: throw ApiError.Other("failed", "The test world gave no code.", 0)
                val pub = app.key.create()
                val out = SignIn.enrollWithCode(probe, pub, SignIn.deviceName() + " (emulator)", code)
                val id = out.str("id") ?: throw ApiError.Other("failed", "The box enrolled no key.", 0)
                app.prefs.setAddress(address)
                app.prefs.setKeyId(id)
            } catch (e: Exception) { fail(e, address) }
            busy = false
        }
    }

    // The page comes back on vyre://enrolled?id=<key id>, or ?error=cancelled.
    val pending by activity.pending.collectAsState()
    LaunchedEffect(pending) {
        val uri = pending?.data ?: return@LaunchedEffect
        if (uri.scheme != SignIn.SCHEME || uri.host != SignIn.HOST) return@LaunchedEffect
        activity.pending.value = null
        waiting = false
        val id = SignIn.enrolledId(uri)
        when {
            uri.getQueryParameter("error") != null -> line = "Sign-in cancelled. Nothing was enrolled."
            id == null -> line = "The sign-in page came back without a key. Try again."
            id != app.key.id() -> line = "The box enrolled a different key than this phone's. Try again."
            app.prefs.address.value == null -> line = "The box address was lost. Type it again."
            else -> app.prefs.setKeyId(id)
        }
    }

    // Debug: `adb shell am start -n sh.vyre.app/.MainActivity -e sh.vyre.app.TEST_BOX http://10.0.2.2:4801` signs in unattended.
    LaunchedEffect(Unit) {
        if (!BuildConfig.DEBUG) return@LaunchedEffect
        val box = activity.intent?.getStringExtra(EXTRA_TEST_BOX)?.let { Links.address(it) } ?: return@LaunchedEffect
        testWorld(box)
    }

    Page(top = { BrandBar() }) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(Space.s), modifier = Modifier.padding(top = Space.l)) {
                Text("Find your box.", style = Type.h1, color = c.text)
                Text("Type the box's address, the name your Deck opens at. Only your tailnet can reach it.", style = Type.body, color = c.text2)
            }
        }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(Space.s), modifier = Modifier.padding(top = Space.xl)) {
                Label("Address")
                InputBox(typed, { typed = it }, "vyre.your-tailnet.ts.net", mono = true, imeAction = ImeAction.Go, keyboard = KeyboardType.Uri, onGo = { signIn() })
                Row(horizontalArrangement = Arrangement.spacedBy(Space.s), modifier = Modifier.padding(top = Space.s)) {
                    VButton(if (busy) "Signing in" else if (waiting) "Open the page again" else "Sign in", onClick = { signIn() },
                        kind = ButtonKind.Primary, enabled = !busy && typed.isNotBlank(), modifier = Modifier.weight(1f))
                }
                line?.let { Text(it, style = Type.small, color = c.text2, modifier = Modifier.padding(top = Space.s)) }
            }
        }
        if (BuildConfig.DEBUG && BuildConfig.DEFAULT_ADDRESS.isNotEmpty()) item {
            Column(verticalArrangement = Arrangement.spacedBy(Space.s), modifier = Modifier.padding(top = Space.xl)) {
                Hairline()
                Label("Debug build", Modifier.padding(top = Space.m))
                Text("The test world (apps/test/world.js) at ${BuildConfig.DEFAULT_ADDRESS}: a fictional box, enrolled with a one-time code.", style = Type.small, color = c.text2)
                VButton("Use the test world", onClick = { testWorld(BuildConfig.DEFAULT_ADDRESS) }, enabled = !busy)
            }
        }
        item {
            Column(verticalArrangement = Arrangement.spacedBy(Space.s), modifier = Modifier.fillMaxWidth().padding(top = Space.xl)) {
                Hairline()
                Label("How signing in works", Modifier.padding(top = Space.m))
                Text("This phone makes a key that never leaves it. Your Deck's passkey approves it once; after that, your fingerprint on this phone approves drafts, answers sessions and opens the vault.",
                    style = Type.small, color = c.text2)
            }
        }
    }
}

const val EXTRA_TEST_BOX = "sh.vyre.app.TEST_BOX"
