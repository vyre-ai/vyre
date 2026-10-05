package sh.vyre.app.push

import android.app.Service
import android.content.Intent
import android.os.IBinder

/** Built without Firebase (the default): the service exists so the manifest names one, and is disabled there. */
class MessagingService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null
}

/** No FCM in this build: no token, so push.subscribe is never called. */
object FcmToken {
    const val AVAILABLE = false
    suspend fun get(): String? = null
}
