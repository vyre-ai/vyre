// VyreCredentialActivity: what a Vyre entry in the Credential Manager sheet does once picked.
// Every path opens the fill window first when there is none (UnlockingActivity: the device key
// behind BiometricPrompt).
//
//   unlock    the "Unlock Vyre" action: unlock, POST identities, hand back the entries
//             (setBeginGetCredentialResponse).
//   password  POST fill { name, url } for the caller's origin or android://<pkg>@<sha256>, and
//             return a PasswordCredential.
//   passkey   work out the caller's origin (a privileged browser's web origin, else
//             android:apk-key-hash:<b64url sha256 cert>), check it may use the rpId (web: host
//             under the rpId; app: the site's assetlinks.json), build clientDataJSON, sign over the
//             platform's clientDataHash when it gave one (else over ours) with POST passkey.assert,
//             and return a PublicKeyCredential in the toJSON() shape.
//   create    a password: POST save. A passkey: the same origin and rpId checks, then POST
//             passkey.register, and return the registration JSON.
//
// A failure goes back to the caller as a Credential Manager exception in the result Intent.
// Values travel only in that result, never in an extra this module sets. Nothing is logged.

package sh.vyre.autofill

import android.content.Intent
import android.os.Bundle
import androidx.annotation.RequiresApi
import androidx.credentials.CreatePasswordRequest
import androidx.credentials.CreatePasswordResponse
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PasswordCredential
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialUnknownException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialUnknownException
import androidx.credentials.provider.PendingIntentHandler
import org.json.JSONArray
import org.json.JSONObject

@RequiresApi(34)
class VyreCredentialActivity : UnlockingActivity() {
  private var kind: String = ""
  private var paired: Paired? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (savedInstanceState != null) { cancel(); return }
    kind = intent.getStringExtra(CredentialAccess.EXTRA_KIND) ?: run { cancel(); return }
    paired = VaultStore.paired(this) ?: run { fail("pair this phone in the Vyre app first"); return }
    when (kind) {
      CredentialAccess.KIND_UNLOCK -> unlockAndList()
      CredentialAccess.KIND_PASSWORD -> password()
      CredentialAccess.KIND_PASSKEY -> passkey()
      CredentialAccess.KIND_CREATE -> create()
      else -> cancel()
    }
  }

  private fun client() = paired!!.let { FillClient(it.server, it.token) }

  private fun unlock(title: String, subtitle: String, then: (String) -> Unit) = withSession(client(), title, subtitle, false, then)

  // ---- get ------------------------------------------------------------------------------------

  private fun unlockAndList() {
    val request = PendingIntentHandler.retrieveBeginGetCredentialRequest(intent) ?: return fail("the request went away")
    val caller = CredentialAccess.caller(this, request.callingAppInfo) ?: return fail("Vyre could not tell who is asking")
    unlock("Unlock Vyre", label(caller)) { session ->
      background({ client().post("identities", JSONObject(), session) }) { data ->
        val response = CredentialAccess.response(this, request, caller, CredentialAccess.identities(data))
        finishOk(Intent().also { PendingIntentHandler.setBeginGetCredentialResponse(it, response) })
      }
    }
  }

  private fun password() {
    val request = PendingIntentHandler.retrieveProviderGetCredentialRequest(intent) ?: return fail("the request went away")
    val caller = CredentialAccess.caller(this, request.callingAppInfo) ?: return fail("Vyre could not tell who is asking")
    val name = intent.getStringExtra(CredentialAccess.EXTRA_NAME) ?: return fail("no login was picked")
    val url = CredentialCore.fillUrl(caller) ?: return fail("this app has no origin Vyre can fill")
    unlock("Sign in with $name", label(caller)) { session ->
      background({ client().post("fill", JSONObject().put("name", name).put("url", url), session) }) { v ->
        val user = v.optString("username", "")
        val pass = v.optString("password", "")
        if (user.isEmpty() || pass.isEmpty()) return@background fail("$name has no username and password")
        finishOk(Intent().also { PendingIntentHandler.setGetCredentialResponse(it, GetCredentialResponse(PasswordCredential(user, pass))) })
      }
    }
  }

  private fun passkey() {
    val request = PendingIntentHandler.retrieveProviderGetCredentialRequest(intent) ?: return fail("the request went away")
    val caller = CredentialAccess.caller(this, request.callingAppInfo) ?: return fail("Vyre could not tell who is asking")
    val name = intent.getStringExtra(CredentialAccess.EXTRA_NAME) ?: return fail("no passkey was picked")
    val credential = intent.getStringExtra(CredentialAccess.EXTRA_CREDENTIAL) ?: return fail("no passkey was picked")
    val option = request.credentialOptions.filterIsInstance<GetPublicKeyCredentialOption>().firstOrNull() ?: return fail("the request asks for no passkey")
    val req = runCatching { JSONObject(option.requestJson) }.getOrNull() ?: return fail("the passkey request does not parse")
    val challenge = req.optString("challenge", "").ifEmpty { return fail("the passkey request has no challenge") }
    val rpId = CredentialCore.rpIdFor(req.optString("rpId", ""), caller) ?: return fail("the passkey request names no site")
    val origin = CredentialCore.callerOrigin(caller) ?: return fail("Vyre could not tell who is asking")
    val clientData = CredentialCore.clientDataJson("webauthn.get", challenge, origin, if (caller.webOrigin == null) caller.packageName else null)
    val hash = CredentialCore.clientDataHash(option.clientDataHash, clientData)
    checkRp(rpId, caller) {
      unlock("Sign in with $name", rpId) { session ->
        val body = JSONObject().put("rpId", rpId).put("clientDataHash", CredentialCore.b64url(hash)).put("credential", credential)
        background({ client().post("passkey.assert", body, session) }) { a ->
          val json = CredentialCore.assertionJson(
            a.optString("credentialId", credential), CredentialCore.b64url(clientData.toByteArray(Charsets.UTF_8)),
            a.optString("authenticatorData", ""), a.optString("signature", ""), a.optString("userHandle", "").ifEmpty { null },
          )
          finishOk(Intent().also { PendingIntentHandler.setGetCredentialResponse(it, GetCredentialResponse(PublicKeyCredential(json))) })
        }
      }
    }
  }

  // ---- create ---------------------------------------------------------------------------------

  private fun create() {
    val request = PendingIntentHandler.retrieveProviderCreateCredentialRequest(intent) ?: return fail("the request went away")
    val caller = CredentialAccess.caller(this, request.callingAppInfo) ?: return fail("Vyre could not tell who is asking")
    when (val r = request.callingRequest) {
      is CreatePasswordRequest -> {
        val url = CredentialCore.fillUrl(caller) ?: return fail("this app has no origin Vyre can save for")
        unlock("Save to Vyre", label(caller)) { session ->
          val body = VyreAutofillService.saveBody(url, r.id, r.password)
          background({ client().post("save", body, session) }) { s ->
            toast("Saved to Vyre as ${s.optString("name", "")}")
            finishOk(Intent().also { PendingIntentHandler.setCreateCredentialResponse(it, CreatePasswordResponse()) })
          }
        }
      }
      is CreatePublicKeyCredentialRequest -> registerPasskey(r, caller)
      else -> fail("Vyre saves passwords and passkeys only")
    }
  }

  private fun registerPasskey(r: CreatePublicKeyCredentialRequest, caller: Caller) {
    val req = runCatching { JSONObject(r.requestJson) }.getOrNull() ?: return fail("the passkey request does not parse")
    val challenge = req.optString("challenge", "").ifEmpty { return fail("the passkey request has no challenge") }
    val rpId = CredentialCore.rpIdFor(req.optJSONObject("rp")?.optString("id", ""), caller) ?: return fail("the passkey request names no site")
    val user = req.optJSONObject("user") ?: return fail("the passkey request names no account")
    val algs = JSONArray()
    req.optJSONArray("pubKeyCredParams")?.let { p -> for (i in 0 until p.length()) p.optJSONObject(i)?.let { if (it.has("alg")) algs.put(it.optInt("alg")) } }
    val exclude = JSONArray(CredentialAccess.allowIds(req.optJSONArray("excludeCredentials")))
    val origin = CredentialCore.callerOrigin(caller) ?: return fail("Vyre could not tell who is asking")
    val clientData = CredentialCore.clientDataJson("webauthn.create", challenge, origin, if (caller.webOrigin == null) caller.packageName else null)
    val hash = CredentialCore.clientDataHash(r.clientDataHash, clientData)
    checkRp(rpId, caller) {
      unlock("Save a passkey for $rpId", user.optString("name", "")) { session ->
        val body = JSONObject()
          .put("rpId", rpId).put("clientDataHash", CredentialCore.b64url(hash))
          .put("user", JSONObject().put("id", user.optString("id", "")).put("name", user.optString("name", "")).put("displayName", user.optString("displayName", "")))
          .put("algs", algs).put("exclude", exclude)
        background({ client().post("passkey.register", body, session) }) { m ->
          val json = CredentialCore.registrationJson(
            m.optString("credentialId", ""), CredentialCore.b64url(clientData.toByteArray(Charsets.UTF_8)),
            m.optString("attestationObject", ""), m.optString("authenticatorData", "").ifEmpty { null }, m.optString("publicKey", "").ifEmpty { null },
          )
          finishOk(Intent().also { PendingIntentHandler.setCreateCredentialResponse(it, CreatePublicKeyCredentialResponse(json)) })
        }
      }
    }
  }

  // ---- checks and failures --------------------------------------------------------------------

  /**
   * Go on only when this caller may use rpId: a privileged browser's web origin must sit under it;
   * an app must be named in the site's assetlinks.json with this certificate.
   */
  private fun checkRp(rpId: String, caller: Caller, then: () -> Unit) {
    if (caller.webOrigin != null) {
      if (CredentialCore.rpAllowed(rpId, caller, null)) then() else fail("${CredentialCore.normalWebOrigin(caller.webOrigin)} may not use passkeys for $rpId")
      return
    }
    if (!CredentialCore.validRpId(rpId)) return fail("$rpId is not a site")
    background({ CredentialAccess.assetLinks(rpId) }) { links ->
      if (CredentialCore.rpAllowed(rpId, caller, links)) then() else fail("$rpId does not list this app in its asset links")
    }
  }

  private fun label(c: Caller) = c.webOrigin?.let { originLabel(it) } ?: c.packageName

  private val creating get() = kind == CredentialAccess.KIND_CREATE

  override fun fail(why: String) {
    if (done) return
    toast(why)
    val i = Intent()
    if (creating) PendingIntentHandler.setCreateCredentialException(i, CreateCredentialUnknownException(why))
    else if (kind != CredentialAccess.KIND_UNLOCK) PendingIntentHandler.setGetCredentialException(i, GetCredentialUnknownException(why))
    finishWith(if (kind == CredentialAccess.KIND_UNLOCK) RESULT_CANCELED else RESULT_OK, i)
  }

  override fun cancel() {
    if (done) return
    val i = Intent()
    if (creating) PendingIntentHandler.setCreateCredentialException(i, CreateCredentialCancellationException("canceled"))
    else if (kind == CredentialAccess.KIND_PASSWORD || kind == CredentialAccess.KIND_PASSKEY) PendingIntentHandler.setGetCredentialException(i, GetCredentialCancellationException("canceled"))
    finishWith(if (kind == CredentialAccess.KIND_UNLOCK || kind.isEmpty()) RESULT_CANCELED else RESULT_OK, i)
  }
}
