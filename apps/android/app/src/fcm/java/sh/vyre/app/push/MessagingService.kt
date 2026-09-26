package sh.vyre.app.push

import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/**
 * FCM data-only messages. Google sees a kind and a fixed sentence; the id is sealed to this phone
 * (ADR 0015 section 4). The app opens the seal and posts the notification itself.
 */
class MessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        Notifier.fromData(applicationContext, message.data)
    }

    override fun onNewToken(token: String) {
        PushRegistration.tokenChanged(applicationContext, token)
    }
}

object FcmToken {
    const val AVAILABLE = true
    suspend fun get(): String? = suspendCancellableCoroutine { cont ->
        FirebaseMessaging.getInstance().token.addOnCompleteListener { t -> cont.resume(if (t.isSuccessful) t.result else null) }
    }
}
