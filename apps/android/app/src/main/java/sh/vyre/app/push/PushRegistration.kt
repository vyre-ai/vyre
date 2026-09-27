package sh.vyre.app.push

import android.content.Context
import sh.vyre.app.api.ApiError
import sh.vyre.app.api.Client
import sh.vyre.app.api.input
import sh.vyre.app.api.plain
import sh.vyre.app.api.str

/** push.subscribe over FCM, and what to say when it cannot happen yet. */
object PushRegistration {
    const val NEEDS_UPDATE = "Notifications need the box's push update."
    const val NO_FCM = "This build has no Firebase messaging. Build with -Pvyre.fcm=true and your own google-services.json."

    /** Registers this phone for push. Returns null on success, else a sentence for Settings. */
    suspend fun subscribe(context: Context, client: Client): String? {
        if (!FcmToken.AVAILABLE) return NO_FCM
        val token = FcmToken.get() ?: return "Firebase gave no token. Is Play services on this phone?"
        val key = PushKey.create(context)
        return try {
            val out = client.call("push.subscribe", input("transport" to "fcm", "token" to token, "key" to key, "label" to sh.vyre.app.presence.SignIn.deviceName()))
            context.getSharedPreferences("push", Context.MODE_PRIVATE).edit().putString("device", out.str("device")).putBoolean("stale", false).apply()
            null
        } catch (e: ApiError.NoSuchTool) { NEEDS_UPDATE } catch (e: ApiError.BadInput) { NEEDS_UPDATE } catch (e: Exception) { e.plain() }
    }

    fun device(context: Context): String? = context.getSharedPreferences("push", Context.MODE_PRIVATE).getString("device", null)

    /** FCM rotated the token: mark it, and the next launch re-subscribes. */
    fun tokenChanged(context: Context, token: String) {
        context.getSharedPreferences("push", Context.MODE_PRIVATE).edit().putBoolean("stale", true).apply()
    }

    fun wipe(context: Context) {
        context.getSharedPreferences("push", Context.MODE_PRIVATE).edit().clear().apply()
        PushKey.wipe(context)
    }
}
