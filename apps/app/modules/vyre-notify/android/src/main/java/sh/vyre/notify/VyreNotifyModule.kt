// Local notices on Android: the permission, a channel, and a notice whose tap opens a vyre:// link.
// Nothing here talks to a server or to Google Play services.

package sh.vyre.notify

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class VyreNotifyModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("ERR_NO_CONTEXT", "the app has no context yet", null)

  private fun channel(ctx: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (nm.getNotificationChannel(CHANNEL) == null) {
      nm.createNotificationChannel(NotificationChannel(CHANNEL, "Needs you", NotificationManager.IMPORTANCE_DEFAULT))
    }
  }

  /** granted / canAskAgain / status, the shape the app reads. */
  private fun state(granted: Boolean, asked: Boolean): Map<String, Any> = mapOf(
    "granted" to granted,
    "canAskAgain" to (!granted && !asked),
    "status" to if (granted) "granted" else if (asked) "denied" else "undetermined",
  )

  override fun definition() = ModuleDefinition {
    Name("VyreNotify")

    AsyncFunction("getPermission") { promise: Promise ->
      val ctx = context
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
        promise.resolve(state(NotificationManagerCompat.from(ctx).areNotificationsEnabled(), true))
      } else {
        Permissions.getPermissionsWithPermissionsManager(appContext.permissions, promise, Manifest.permission.POST_NOTIFICATIONS)
      }
    }

    AsyncFunction("requestPermission") { promise: Promise ->
      val ctx = context
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
        promise.resolve(state(NotificationManagerCompat.from(ctx).areNotificationsEnabled(), true))
      } else {
        Permissions.askForPermissionsWithPermissionsManager(appContext.permissions, promise, Manifest.permission.POST_NOTIFICATIONS)
      }
    }

    /**
     * Notices with the app closed: a foreground service holds the app's connection to the home (KeepAliveService). Asked for by the person; remembered, so a restart of the service knows. Needs the notice
     * permission first (the ongoing notice is one), and answers false without it.
     */
    AsyncFunction("startKeepAlive") {
      val ctx = context
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return@AsyncFunction false
      ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEEP, true).apply()
      ContextCompat.startForegroundService(ctx, Intent(ctx, KeepAliveService::class.java))
      true
    }

    AsyncFunction("stopKeepAlive") {
      val ctx = context
      ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEEP, false).apply()
      ctx.stopService(Intent(ctx, KeepAliveService::class.java))
      true
    }

    /** Whether the person wants the connection kept: true until they turn it off. */
    AsyncFunction("keepAliveWanted") { context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEEP, true) }

    /** Show a notice now. `route` is an app path such as /u/now; a tap opens vyre://u/now?notice=1. */
    AsyncFunction("show") { id: String, title: String, body: String?, route: String? ->
      val ctx = context
      if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return@AsyncFunction false
      channel(ctx)
      val open = Intent(Intent.ACTION_VIEW).apply {
        setPackage(ctx.packageName)
        data = Uri.parse(if (route != null && route.startsWith("/")) "vyre:/$route?notice=1" else "vyre://")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      }
      val tap = PendingIntent.getActivity(ctx, id.hashCode(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      val n = NotificationCompat.Builder(ctx, CHANNEL)
        .setSmallIcon(ctx.applicationInfo.icon)
        .setContentTitle(title)
        .setContentText(body)
        .setContentIntent(tap)
        .setAutoCancel(true)
        .build()
      NotificationManagerCompat.from(ctx).notify(id, 0, n)
      true
    }
  }

  companion object {
    const val CHANNEL = "needs-you"
    const val PREFS = "vyre.notify"
    const val KEEP = "keep-connected"
  }
}
