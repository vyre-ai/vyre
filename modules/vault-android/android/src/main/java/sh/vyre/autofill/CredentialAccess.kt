// The Android half of Credential Manager support: reading the caller, Google's allowlist of
// privileged browsers, a site's Digital Asset Links, the request JSON, and building the entries
// the system sheet shows. The decisions themselves are CredentialCore's.

package sh.vyre.autofill

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.annotation.RequiresApi
import androidx.credentials.provider.BeginGetCredentialRequest
import androidx.credentials.provider.BeginGetCredentialResponse
import androidx.credentials.provider.BeginGetPasswordOption
import androidx.credentials.provider.BeginGetPublicKeyCredentialOption
import androidx.credentials.provider.CallingAppInfo
import androidx.credentials.provider.PasswordCredentialEntry
import androidx.credentials.provider.PublicKeyCredentialEntry
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicInteger

/** One entry of vyred's `identities` route. */
data class Identity(
  val name: String, val kind: String, val user: String,
  val sites: List<String> = emptyList(), val apps: List<String> = emptyList(),
  val rp: String? = null, val credential: String? = null,
)

@RequiresApi(34)
object CredentialAccess {
  const val EXTRA_KIND = "sh.vyre.credential.KIND"
  const val EXTRA_NAME = "sh.vyre.credential.NAME"
  const val EXTRA_CREDENTIAL = "sh.vyre.credential.ID"

  const val KIND_UNLOCK = "unlock"
  const val KIND_PASSWORD = "password"
  const val KIND_PASSKEY = "passkey"
  const val KIND_CREATE = "create"

  private val requestCodes = AtomicInteger((System.currentTimeMillis() and 0xffff).toInt() + 0x10000)
  @Volatile private var allowlist: String? = null

  /** Google's list of browsers allowed to say which web origin they are calling for (res/raw). */
  fun allowlist(context: Context): String = allowlist ?: synchronized(this) {
    allowlist ?: context.resources.openRawResource(R.raw.vyre_privileged_browsers).use { it.readBytes().toString(Charsets.UTF_8) }.also { allowlist = it }
  }

  /**
   * The caller: its package, its one signing certificate's SHA-256, and a web origin when it is an
   * allowlisted browser that gave one. A package not on the list that claims an origin is taken
   * as the app it is.
   */
  fun caller(context: Context, info: CallingAppInfo?): Caller? {
    info ?: return null
    val si = info.signingInfo
    val cert = if (si.hasMultipleSigners()) null else si.apkContentsSigners.singleOrNull()?.let { AutofillCore.certSha256(it.toByteArray()) }
    val web = if (info.isOriginPopulated()) runCatching { info.getOrigin(allowlist(context)) }.getOrNull() else null
    return Caller(info.packageName, cert, web)
  }

  /** A PendingIntent to VyreCredentialActivity. Mutable: the framework adds the request to it. */
  fun pending(context: Context, kind: String, name: String? = null, credential: String? = null): PendingIntent {
    val i = Intent(context, VyreCredentialActivity::class.java).putExtra(EXTRA_KIND, kind)
    if (name != null) i.putExtra(EXTRA_NAME, name)
    if (credential != null) i.putExtra(EXTRA_CREDENTIAL, credential)
    return PendingIntent.getActivity(context, requestCodes.incrementAndGet(), i, PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  fun identities(data: JSONObject): List<Identity> {
    val a = data.optJSONArray("identities") ?: return emptyList()
    return (0 until a.length()).mapNotNull { i ->
      val o = a.optJSONObject(i) ?: return@mapNotNull null
      val name = o.optString("name", "").takeIf { it.isNotEmpty() } ?: return@mapNotNull null
      Identity(
        name = name, kind = o.optString("kind", ""), user = o.optString("user", "").ifEmpty { name },
        sites = strings(o.optJSONArray("sites")), apps = strings(o.optJSONArray("apps")),
        rp = o.optString("rp", "").ifEmpty { null }, credential = o.optString("credential", "").ifEmpty { null },
      )
    }
  }

  fun strings(a: JSONArray?): List<String> = if (a == null) emptyList() else (0 until a.length()).mapNotNull { a.optString(it, "").ifEmpty { null } }

  /**
   * The entries for a request: logins for the caller's exact origin or app, passkeys for the
   * request's rpId that the caller may claim on its face (a web origin under the rpId; an app is
   * checked against the site's asset links when it picks one, in VyreCredentialActivity).
   */
  fun response(context: Context, request: BeginGetCredentialRequest, caller: Caller, ids: List<Identity>): BeginGetCredentialResponse {
    val b = BeginGetCredentialResponse.Builder()
    for (option in request.beginGetCredentialOptions) {
      when (option) {
        is BeginGetPasswordOption -> ids.filter { it.kind == "login" && CredentialCore.loginFor(it.sites, it.apps, caller) }.forEach {
          b.addCredentialEntry(PasswordCredentialEntry.Builder(context, it.user, pending(context, KIND_PASSWORD, it.name), option).setDisplayName(it.name).build())
        }
        is BeginGetPublicKeyCredentialOption -> {
          val req = runCatching { JSONObject(option.requestJson) }.getOrNull() ?: continue
          val rpId = CredentialCore.rpIdFor(req.optString("rpId", ""), caller) ?: continue
          if (caller.webOrigin != null && !CredentialCore.rpAllowedForWeb(rpId, caller.webOrigin)) continue
          if (caller.webOrigin == null && !CredentialCore.validRpId(rpId)) continue
          val allow = allowIds(req.optJSONArray("allowCredentials"))
          ids.filter { it.kind == "passkey" && it.rp == rpId && it.credential != null && (allow.isEmpty() || it.credential in allow) }.forEach {
            b.addCredentialEntry(PublicKeyCredentialEntry.Builder(context, it.user, pending(context, KIND_PASSKEY, it.name, it.credential), option).setDisplayName(it.name).build())
          }
        }
        else -> {}
      }
    }
    return b.build()
  }

  /** Credential ids in allowCredentials or excludeCredentials. */
  fun allowIds(a: JSONArray?): List<String> =
    if (a == null) emptyList() else (0 until a.length()).mapNotNull { a.optJSONObject(it)?.optString("id", "")?.ifEmpty { null } }

  /**
   * A site's Digital Asset Links, or null when it cannot be read. https only, no redirects, a
   * short timeout and a size cap: a slow or hostile site gets no passkey, not a hang.
   */
  fun assetLinks(rpId: String): List<AssetStatement>? {
    if (!CredentialCore.validRpId(rpId)) return null
    return try {
      val c = URL("https://$rpId/.well-known/assetlinks.json").openConnection() as HttpURLConnection
      try {
        c.connectTimeout = 3_000; c.readTimeout = 3_000; c.instanceFollowRedirects = false
        c.setRequestProperty("accept", "application/json")
        if (c.responseCode != 200) return null
        val bytes = c.inputStream.use { s -> s.readNBytes(256 * 1024) }
        val a = JSONArray(bytes.toString(Charsets.UTF_8))
        (0 until a.length()).mapNotNull { i ->
          val o = a.optJSONObject(i) ?: return@mapNotNull null
          val t = o.optJSONObject("target")
          AssetStatement(strings(o.optJSONArray("relation")), t?.optString("namespace"), t?.optString("package_name"), strings(t?.optJSONArray("sha256_cert_fingerprints")))
        }
      } finally { c.disconnect() }
    } catch (e: Exception) { null }
  }
}
