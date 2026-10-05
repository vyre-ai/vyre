package sh.vyre.app.push

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import sh.vyre.app.MainActivity
import sh.vyre.app.R

/** Channels and the one notification a push becomes: a fixed title, no content, a tap that opens the item. */
object Notifier {
    const val NEEDS = "needs"
    const val WATCHING = "watching"
    const val EXTRA_PATH = "sh.vyre.app.PATH"

    fun channels(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(NEEDS, "Needs you", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "A held email, a spend or a session asking before it runs."
        })
        nm.createNotificationChannel(NotificationChannel(WATCHING, "Watching", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "A session you are watching finished or asked."
        })
    }

    /** The fixed sentence per kind. The box sends one too; the app uses its own so nothing new appears. */
    fun title(kind: String?): String = when (kind) {
        "ask" -> "A session is waiting for your answer"
        "draft" -> "Something is waiting for your approval"
        "watch" -> "A session you are watching has news"
        "lesson" -> "Vyre has a lesson for you to look at"
        else -> "Vyre needs you"
    }

    /** An FCM data message: {kind, sealed}. Unreadable seals are dropped. */
    fun fromData(context: Context, data: Map<String, String>) {
        val key = PushKey.get(context) ?: return
        val opened = data["sealed"]?.let { Seal.open(key, it) } ?: return
        post(context, data["kind"], opened.path, opened.tag)
    }

    fun post(context: Context, kind: String?, path: String, tag: String?) {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        val open = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP).putExtra(EXTRA_PATH, path)
        val pi = PendingIntent.getActivity(context, path.hashCode(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val channel = if (kind == "watch") WATCHING else NEEDS
        val n = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title(kind))
            .setContentIntent(pi).setAutoCancel(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setCategory(if (channel == NEEDS) NotificationCompat.CATEGORY_REMINDER else NotificationCompat.CATEGORY_STATUS)
            .build()
        runCatching { NotificationManagerCompat.from(context).notify(tag ?: path, 1, n) }
    }
}
