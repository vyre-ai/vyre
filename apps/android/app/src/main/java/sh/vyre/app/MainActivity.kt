package sh.vyre.app

import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import sh.vyre.app.api.Prover
import sh.vyre.app.design.VyreTheme
import sh.vyre.app.ui.Root

/**
 * The one activity. The event stream runs only while it is STARTED (in front) and closes when
 * it leaves; nothing reads in the background.
 */
class MainActivity : FragmentActivity() {
    /** A link to open: vyre://enrolled, a notification's /needs/<id>, a shared file. */
    val pending = MutableStateFlow<Intent?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val app = vyre
        app.client.prover = Prover { tool, input, reason -> app.key.sign(this, tool, input, reason) }
        pending.value = intent
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                app.prefs.keyId.collect { id -> if (id != null && app.prefs.address.value != null) app.stream.start() else app.stream.stop() }
            }
        }
        setContent {
            val theme by app.prefs.theme.collectAsState()
            VyreTheme(theme) { Root(this) }
        }
    }

    override fun onStop() {
        super.onStop()
        vyre.stream.stop()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        pending.value = intent
    }
}
