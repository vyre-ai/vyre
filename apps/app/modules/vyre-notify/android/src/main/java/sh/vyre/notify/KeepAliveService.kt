// Keeps Vyre's own connection to the person's home alive while the app is closed, so a notice can be made when something needs them. Nothing here talks to a server or to Google Play services:
// it is an ordinary foreground service (the ongoing "Vyre is connected" notice the system requires), and the same JavaScript loop that tells the person while the app is open runs in it as a headless task
// (src/native/headless.android.ts, "VyreNotices"). It stops when the person turns notices off.

package sh.vyre.notify

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

class KeepAliveService : HeadlessJsTaskService() {
  /** The loop has no end of its own: no time limit, and it may start while the app is in front. */
  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? =
    HeadlessJsTaskConfig(TASK, Arguments.createMap(), 0, true)

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    ServiceCompat.startForeground(this, ID, ongoing(this), if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0)
    super.onStartCommand(intent, flags, startId)
    return START_STICKY
  }

  companion object {
    const val TASK = "VyreNotices"
    const val CHANNEL = "connected"
    const val ID = 7301

    /** The one ongoing notice: quiet, no sound, and a tap opens the app. */
    fun ongoing(ctx: Context): Notification {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL) == null) {
          nm.createNotificationChannel(NotificationChannel(CHANNEL, "Connected", NotificationManager.IMPORTANCE_MIN).apply { setShowBadge(false) })
        }
      }
      val open = Intent(Intent.ACTION_VIEW).apply {
        setPackage(ctx.packageName)
        data = Uri.parse("vyre://")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      }
      val tap = PendingIntent.getActivity(ctx, ID, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      return NotificationCompat.Builder(ctx, CHANNEL)
        .setSmallIcon(ctx.applicationInfo.icon)
        .setContentTitle("Vyre is connected")
        .setContentText("So it can tell you when something needs you.")
        .setContentIntent(tap)
        .setOngoing(true)
        .setSilent(true)
        .setPriority(NotificationCompat.PRIORITY_MIN)
        .build()
    }
  }
}
