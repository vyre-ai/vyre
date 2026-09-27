package sh.vyre.app

import android.app.Application
import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import sh.vyre.app.api.Client
import sh.vyre.app.api.EventStream
import sh.vyre.app.data.Cache
import sh.vyre.app.design.ThemeChoice
import sh.vyre.app.presence.DeviceKey
import sh.vyre.app.push.Notifier
import java.io.File

/** The app's few long-lived things. One Client, one EventStream, one device key. */
class VyreApp : Application() {
    lateinit var prefs: Prefs
    lateinit var cache: Cache
    lateinit var client: Client
    lateinit var stream: EventStream
    lateinit var key: DeviceKey
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    /**
     * Needs you rows answered, or waiting out an Undo, from Now's swipes or the detail sheet: Now
     * collapses them at once and pulses the next row, before the box's event arrives.
     */
    val settled = MutableStateFlow<Set<String>>(emptySet())
    /** Each session's last words as the stream last said them, for the Chats list (threads.list has none). */
    val lastLines = androidx.compose.runtime.mutableStateMapOf<String, String>()

    override fun onCreate() {
        super.onCreate()
        prefs = Prefs(this)
        cache = Cache(File(filesDir, "cache"))
        cache.prune()
        client = Client({ prefs.address.value }, cache)
        stream = EventStream(client, scope)
        key = DeviceKey(this)
        Notifier.channels(this)
    }

    /** Sign out, local half: the key, the cache, the push key, the address. */
    fun wipe() {
        client.presenceSession = null
        key.delete()
        cache.wipe()
        sh.vyre.app.push.PushRegistration.wipe(this)
        File(cacheDir, "fetched").deleteRecursively()
        prefs.clear()
        stream.stop()
        stream.lastId = null
    }
}

val Context.vyre: VyreApp get() = applicationContext as VyreApp

/**
 * The box address, whether sign-in finished, and the theme. App-private prefs, excluded from
 * backup. (The key itself is in the Keystore.)
 */
class Prefs(context: Context) {
    private val p = context.getSharedPreferences("vyre", Context.MODE_PRIVATE)
    val address = MutableStateFlow(p.getString("address", null))
    val keyId = MutableStateFlow(p.getString("key_id", null))
    val theme = MutableStateFlow(runCatching { ThemeChoice.valueOf(p.getString("theme", "System")!!) }.getOrDefault(ThemeChoice.System))

    fun setAddress(a: String?) { p.edit().putString("address", a).apply(); address.value = a }
    fun setKeyId(id: String?) { p.edit().putString("key_id", id).apply(); keyId.value = id }
    fun setTheme(t: ThemeChoice) { p.edit().putString("theme", t.name).apply(); theme.value = t }
    fun clear() { p.edit().remove("address").remove("key_id").apply(); address.value = null; keyId.value = null }
}
