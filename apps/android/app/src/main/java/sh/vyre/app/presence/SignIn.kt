package sh.vyre.app.presence

import android.content.Context
import android.net.Uri
import android.os.Build
import androidx.browser.customtabs.CustomTabsIntent
import kotlinx.serialization.json.JsonElement
import sh.vyre.app.api.Client
import sh.vyre.app.api.input
import java.net.URLEncoder

/**
 * Signing in is enrolling this phone's device key with a proof from something already trusted
 * (ADR 0015 section 3): the Deck's passkey, in the system browser at the box's own origin.
 */
object SignIn {
    const val SCHEME = "vyre"
    const val HOST = "enrolled"

    /** https://<address>/onboard/device#k=<SPKI b64url>&n=<name>&r=vyre. The fragment never reaches a server log. */
    fun url(address: String, publicKey: String, name: String): String {
        val base = address.trimEnd('/')
        return "$base/onboard/device#k=${enc(publicKey)}&n=${enc(name)}&r=$SCHEME"
    }

    /** The key id from vyre://enrolled?id=<key id>, or null if the link is anything else. */
    fun enrolledId(uri: Uri?): String? = uri?.takeIf { it.scheme == SCHEME && it.host == HOST }?.getQueryParameter("id")
    fun enrolledId(uri: String): String? = Regex("^vyre://enrolled\\?(?:.*&)?id=([A-Za-z0-9_-]{8,128})(?:&.*)?$").find(uri)?.groupValues?.get(1)

    fun open(context: Context, address: String, publicKey: String, name: String) {
        CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(context, Uri.parse(url(address, publicKey, name)))
    }

    /** "Pixel 7", what Settings on the Deck lists this phone as. */
    fun deviceName(): String = listOf(Build.MANUFACTURER.replaceFirstChar { it.uppercase() }, Build.MODEL).distinct()
        .joinToString(" ").let { if (it.startsWith(Build.MANUFACTURER, true) && Build.MODEL.startsWith(Build.MANUFACTURER, true)) Build.MODEL else it }

    /**
     * Enroll with a one-time code from `vyre presence code` (also the test world's POST /__test/code):
     * presence.enroll with `code code=<code>`. The box accepts a code for presence.enroll only.
     */
    suspend fun enrollWithCode(client: Client, publicKey: String, name: String, code: String): JsonElement =
        client.call("presence.enroll", input("kind" to "device", "public_key" to publicKey, "alg" to -7, "name" to name),
            presence = "code code=" + code.uppercase().replace(Regex("[\\s-]"), ""))

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8").replace("+", "%20")
}
