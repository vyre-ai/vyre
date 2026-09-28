// The app's side of Vyre autofill: pairing, status, unpairing, and the system setting.
//
//   setServer(url)          the fill listener's base URL; https, or http://127.0.0.1 in a debug build
//   pair(url, code, name)   make the device key, POST pair { code, name, key: SPKI }, keep the token
//   status()                paired or not, the key's level, whether the fill window is open, whether
//                           vyred answers
//   lock()                  end this phone's fill window now
//   unpair()                end the window, forget the token, delete the device key
//   isEnabled()             Vyre is the phone's autofill service
//   openSettings()          the system screen that picks the autofill service

package sh.vyre.autofill

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.view.autofill.AutofillManager
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

class VyreAutofillModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("ERR_NO_CONTEXT", "the app has no context yet", null)

  private fun server(url: String): String =
    AutofillCore.serverUrl(url, VaultStore.isDebug(context))
      ?: throw CodedException("ERR_BAD_SERVER", "the vault address must be https (http://127.0.0.1 only in a debug build)", null)

  override fun definition() = ModuleDefinition {
    Name("VyreAutofill")

    AsyncFunction("setServer") { url: String ->
      val s = server(url)
      val was = VaultStore.paired(context)
      // A token belongs to the vyred that issued it: another address means pairing again.
      if (was != null && was.server != s) VaultStore.clear(context)
      VaultStore.setServer(context, s)
      s
    }

    AsyncFunction("pair") { url: String, code: String, name: String ->
      val s = server(url)
      VaultStore.setServer(context, s)
      val key = try { DeviceKey.create(context) } catch (e: VyreException) { throw CodedException(e.code, e.message, e) }
      try {
        val r = FillClient(s, null).post("pair", JSONObject().put("code", code).put("name", name).put("key", key))
        val token = r.optString("token", "")
        if (token.isEmpty()) throw FillError("bad_reply", "vyred paired without a token")
        VaultStore.savePairing(context, s, token, r.optString("device", ""), r.optString("name", name))
        Session.clear()
        mapOf("device" to r.optString("device", ""), "name" to r.optString("name", name), "level" to DeviceKey.level())
      } catch (e: FillError) {
        DeviceKey.delete()
        throw CodedException(if (e.code == "network") "ERR_NETWORK" else "ERR_PAIR", "${e.code}: ${e.message}", e)
      }
    }

    AsyncFunction("status") {
      val p = VaultStore.paired(context)
      val base = mutableMapOf<String, Any?>(
        "paired" to (p != null && DeviceKey.exists()),
        "server" to (p?.server ?: VaultStore.server(context)),
        "device" to p?.device,
        "name" to p?.name,
        "level" to DeviceKey.level(),
        "unlocked" to (Session.token() != null),
        "enabled" to enabled(),
        "reachable" to false,
        "revoked" to false,
      )
      if (p != null) {
        try {
          FillClient(p.server, p.token).get("status", timeoutMs = 3_000)
          base["reachable"] = true
        } catch (e: FillError) {
          if (e.code != "network") base["reachable"] = true
          if (e.code == "revoked" || e.code == "unauthorized") base["revoked"] = true
        }
      }
      base
    }

    AsyncFunction("lock") {
      val p = VaultStore.paired(context)
      Session.clear()
      if (p != null) runCatching { FillClient(p.server, p.token).post("lock", JSONObject(), timeoutMs = 3_000) }
      true
    }

    AsyncFunction("unpair") {
      val p = VaultStore.paired(context)
      if (p != null) runCatching { FillClient(p.server, p.token).post("lock", JSONObject(), timeoutMs = 3_000) }
      VaultStore.clear(context)
      true
    }

    Function("isEnabled") { enabled() }

    Function("openSettings") {
      if (Build.VERSION.SDK_INT < 26) return@Function false
      val i = Intent(Settings.ACTION_REQUEST_SET_AUTOFILL_SERVICE, Uri.parse("package:${context.packageName}"))
      val activity = appContext.currentActivity
      if (activity != null) activity.startActivity(i)
      else context.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      true
    }
  }

  private fun enabled(): Boolean {
    if (Build.VERSION.SDK_INT < 26) return false
    val m = context.getSystemService(AutofillManager::class.java) ?: return false
    return runCatching { m.isAutofillSupported && m.hasEnabledAutofillServices() }.getOrDefault(false)
  }
}
