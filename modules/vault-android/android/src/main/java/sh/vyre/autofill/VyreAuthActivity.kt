// VyreAuthActivity: the one tap behind every Vyre suggestion.
//
//   1. With no live fill window: POST challenge, check the message is vyred's unlock message and
//      nothing else, run BiometricPrompt with a CryptoObject around the device key's Signature,
//      sign the message (SHA256withECDSA, DER), POST unlock { signature } and keep the session in
//      memory. A card always asks for a fresh proof: vyred fills a card only within 60 seconds of
//      one (core/vault/fill-cards.js, REPROMPT_MS).
//   2. POST fill, otp, card.fill or address.fill for the item's name and the form's origin. The
//      origin is read here, from the AssistStructure the framework attached, never from an extra.
//   3. Hand the values back as a Dataset through EXTRA_AUTHENTICATION_RESULT and finish.
//
// For a save, the login waits in PendingSaves under the id in the Intent; after the unlock it
// goes to POST save. The screen is translucent: the person sees the system's biometric sheet
// over the app they were in, and a short toast when something fails. Nothing is logged.

package sh.vyre.autofill

import android.app.Activity
import android.app.assist.AssistStructure
import android.content.Intent
import android.os.Bundle
import android.view.autofill.AutofillManager
import android.widget.Toast
import androidx.annotation.RequiresApi
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import org.json.JSONObject
import java.security.Signature
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

@RequiresApi(26)
class VyreAuthActivity : FragmentActivity() {
  private val io: ExecutorService = Executors.newSingleThreadExecutor()
  private lateinit var prompt: BiometricPrompt
  private var onSigned: ((Signature) -> Unit)? = null
  private var done = false

  private lateinit var kind: FillKind
  private var name: String? = null
  private var form: ParsedForm? = null
  private var paired: Paired? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // BiometricPrompt is made in onCreate, as androidx.biometric asks.
    prompt = BiometricPrompt(this, ContextCompat.getMainExecutor(this), object : BiometricPrompt.AuthenticationCallback() {
      override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
        val sig = result.cryptoObject?.signature
        val then = onSigned
        onSigned = null
        if (sig == null || then == null) { fail("the prompt returned no key"); return }
        then(sig)
      }

      override fun onAuthenticationError(code: Int, text: CharSequence) {
        val canceled = code == BiometricPrompt.ERROR_USER_CANCELED || code == BiometricPrompt.ERROR_NEGATIVE_BUTTON || code == BiometricPrompt.ERROR_CANCELED
        if (canceled) cancel() else fail(text.toString())
      }
      // onAuthenticationFailed: one unrecognised finger; the prompt stays up for another try.
    })
    if (savedInstanceState != null) { cancel(); return }

    kind = FillKind.of(intent.getStringExtra(Datasets.EXTRA_KIND)) ?: run { cancel(); return }
    name = intent.getStringExtra(Datasets.EXTRA_NAME)
    paired = VaultStore.paired(this) ?: run { fail("pair this phone in the Vyre app first"); return }

    if (kind != FillKind.SAVE) {
      @Suppress("DEPRECATION")
      val structure = intent.getParcelableExtra<AssistStructure>(AutofillManager.EXTRA_ASSIST_STRUCTURE)
        ?: run { fail("the form went away"); return }
      val f = StructureReader.read(this, structure)
      if (f.origin == null || f.fields.isEmpty() || name.isNullOrEmpty()) { fail("this form has no origin Vyre can fill"); return }
      form = f
    }
    withSession(fresh = kind == FillKind.CARD) { proceed(retried = false) }
  }

  override fun onDestroy() {
    io.shutdownNow()
    super.onDestroy()
  }

  // ---- the fill window ------------------------------------------------------------------------

  /** Run `then` with a live session, unlocking with the device key first when there is none. */
  private fun withSession(fresh: Boolean, then: (String) -> Unit) {
    val live = Session.token()
    if (live != null && (!fresh || System.currentTimeMillis() - Session.openedAt() < FRESH_MS)) { then(live); return }
    val client = client()
    background({ client.post("challenge", JSONObject()) }) { c ->
      val message = AutofillCore.messageToSign(c.optString("challenge", ""), c.optString("message", ""))
        ?: return@background fail("vyred sent a challenge Vyre will not sign")
      val sig = try { DeviceKey.signature() } catch (e: VyreException) { return@background fail(e.message ?: "no device key") }
      onSigned = { unlocked ->
        val signature = try {
          unlocked.update(message.toByteArray(Charsets.UTF_8))
          DeviceKey.b64url(unlocked.sign())
        } catch (e: Exception) { null }
        if (signature == null) fail("the device key did not sign")
        else background({ client.post("unlock", JSONObject().put("signature", signature)) }) { u ->
          val token = u.optString("session", "")
          if (token.isEmpty()) fail("vyred opened no session")
          else { Session.set(token, u.optLong("expires", System.currentTimeMillis() + 60_000)); then(token) }
        }
      }
      val info = BiometricPrompt.PromptInfo.Builder()
        .setTitle(title())
        .setSubtitle(form?.origin?.let { originLabel(it) } ?: paired?.name ?: "")
        .setNegativeButtonText("Cancel")
        .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
        .build()
      try { prompt.authenticate(info, BiometricPrompt.CryptoObject(sig)) } catch (e: Exception) { fail("the fingerprint prompt did not open") }
    }
  }

  private fun title() = if (kind == FillKind.SAVE) "Save to Vyre" else "Fill $name from Vyre"

  /** What the prompt shows under its title: the site's host or the app's package, never a digest. */
  private fun originLabel(o: String) = if (o.startsWith("android://")) o.removePrefix("android://").substringBefore('@') else o.substringAfter("://")

  // ---- the fill -------------------------------------------------------------------------------

  private fun proceed(retried: Boolean) {
    val session = Session.token() ?: return withSession(kind == FillKind.CARD) { proceed(retried) }
    val client = client()
    if (kind == FillKind.SAVE) {
      val held = PendingSaves.take(intent.getStringExtra(Datasets.EXTRA_SAVE_ID)) ?: return fail("the login to save went away; submit the form again")
      background({ client.post("save", VyreAutofillService.saveBody(held.url, held.username, held.password), session) }) { r ->
        val saved = r.optString("name", "")
        toast(if (r.optBoolean("created")) "Saved to Vyre as $saved" else if (r.optBoolean("updated")) "Updated $saved in Vyre" else "$saved is already in Vyre")
        finishWith(null)
      }
      return
    }
    val f = form ?: return cancel()
    val body = JSONObject().put("name", name).put("url", f.origin)
    val route = when (kind) {
      FillKind.LOGIN -> "fill"
      FillKind.OTP -> "otp"
      FillKind.CARD -> "card.fill"
      FillKind.ADDRESS -> "address.fill"
      FillKind.SAVE -> return
    }
    background({ client.post(route, body, session) }, onError = { e ->
      if (!retried && e.code in RELOCK) {
        Session.clear()
        withSession(fresh = true) { proceed(retried = true) }
        true
      } else false
    }) { v ->
      val d = Datasets.Filled(this)
      when (kind) {
        FillKind.LOGIN -> {
          f.ids(Role.USERNAME, Role.EMAIL).forEach { d.text(it, v.optString("username", "")) }
          f.ids(Role.PASSWORD).forEach { d.text(it, v.optString("password", "")) }
          f.ids(Role.OTP).forEach { d.text(it, v.optString("totp", "")) }
        }
        FillKind.OTP -> f.ids(Role.OTP).forEach { d.text(it, v.optString("code", "")) }
        FillKind.CARD -> fillCard(f, d, v)
        FillKind.ADDRESS -> f.fields.forEach { p -> AutofillCore.addressField(p.role)?.let { k -> d.any(p, v.optString(k, "")) } }
        FillKind.SAVE -> {}
      }
      val ds = d.build() ?: return@background fail("$name has nothing for these fields")
      finishWith(ds)
    }
  }

  private fun fillCard(f: ParsedForm, d: Datasets.Filled, v: JSONObject) {
    val month = v.optString("exp_month", "")
    val year = v.optString("exp_year", "")
    for (p in f.fields) {
      when (p.role) {
        Role.CARD_NUMBER -> d.any(p, v.optString("number", ""))
        Role.CARD_HOLDER -> d.any(p, v.optString("holder", ""))
        Role.CARD_CVV -> d.any(p, v.optString("cvv", ""))
        Role.CARD_EXP_MONTH -> d.any(p, month)
        Role.CARD_EXP_YEAR -> d.any(p, AutofillCore.yearFor(year, p.maxLength))
        Role.CARD_EXPIRY -> d.any(p, if (p.maxLength >= 7 && month.isNotEmpty() && year.length == 4) "$month/$year" else v.optString("expiry", ""))
        else -> {}
      }
    }
  }

  // ---- plumbing -------------------------------------------------------------------------------

  private fun client(): FillClient = paired!!.let { FillClient(it.server, it.token) }

  /**
   * Run `work` off the main thread and `then` back on it. A FillError goes to `onError` first
   * (true when it handled it), then to a toast with vyred's own message, which never carries a value.
   */
  private fun background(work: () -> JSONObject, onError: (FillError) -> Boolean = { false }, then: (JSONObject) -> Unit) {
    try {
      io.execute {
        val result = try { Result.success(work()) } catch (e: Exception) { Result.failure(e) }
        runOnUiThread {
          if (done || isFinishing) return@runOnUiThread
          result.fold(then) { e ->
            if (e is FillError) {
              if (e.code in RELOCK) Session.clear()
              if (!onError(e)) fail(if (e.code == "network") "Vyre could not reach your vault" else (e.message ?: "vyred refused"))
            } else fail("Vyre could not finish")
          }
        }
      }
    } catch (e: Exception) { cancel() }
  }

  private fun finishWith(dataset: android.service.autofill.Dataset?) {
    if (done) return
    done = true
    if (dataset != null) setResult(Activity.RESULT_OK, Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, dataset))
    else setResult(Activity.RESULT_OK)
    finish()
  }

  private fun fail(why: String) {
    toast(why)
    cancel()
  }

  private fun cancel() {
    if (done) return
    done = true
    setResult(Activity.RESULT_CANCELED)
    finish()
  }

  private fun toast(s: String) = Toast.makeText(applicationContext, s, Toast.LENGTH_SHORT).show()

  companion object {
    /** Errors after which a new proof is worth one retry. */
    private val RELOCK = setOf("session_required", "session_expired", "reprompt")
    /** A card needs a proof younger than vyred's 60 seconds; leave room for the round trip. */
    private const val FRESH_MS = 45_000L
  }
}
