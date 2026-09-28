// UnlockingActivity: what VyreAuthActivity (autofill) and VyreCredentialActivity (Credential
// Manager) share. It opens vyred's fill window with the device key:
//
//   POST challenge -> check the message is vyred's unlock message and nothing else ->
//   BiometricPrompt with a CryptoObject around the device key's Signature -> sign (SHA256withECDSA,
//   DER, base64url) -> POST unlock { signature } -> the session, kept in memory (Session).
//
// It also runs network calls off the main thread and turns vyred's refusals into a short toast
// with vyred's own message, which never carries a value. Nothing here logs.

package sh.vyre.autofill

import android.app.Activity
import android.os.Bundle
import android.widget.Toast
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import org.json.JSONObject
import java.security.Signature
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

abstract class UnlockingActivity : FragmentActivity() {
  protected val io: ExecutorService = Executors.newSingleThreadExecutor()
  private lateinit var prompt: BiometricPrompt
  private var onSigned: ((Signature) -> Unit)? = null
  protected var done = false
    private set

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
  }

  override fun onDestroy() {
    io.shutdownNow()
    super.onDestroy()
  }

  /**
   * Run `then` with a live session, unlocking with the device key first when there is none.
   * `fresh` asks for a proof younger than FRESH_MS (a card, whose fill vyred allows only within
   * 60 seconds of one).
   */
  protected fun withSession(client: FillClient, title: String, subtitle: String, fresh: Boolean = false, then: (String) -> Unit) {
    val live = Session.token()
    if (live != null && (!fresh || System.currentTimeMillis() - Session.openedAt() < FRESH_MS)) { then(live); return }
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
        .setTitle(title)
        .setSubtitle(subtitle)
        .setNegativeButtonText("Cancel")
        .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
        .build()
      try { prompt.authenticate(info, BiometricPrompt.CryptoObject(sig)) } catch (e: Exception) { fail("the fingerprint prompt did not open") }
    }
  }

  /**
   * Run `work` off the main thread and `then` back on it. A FillError goes to `onError` first
   * (true when it handled it), then to a toast with vyred's own message.
   */
  protected fun <T> background(work: () -> T, onError: (FillError) -> Boolean = { false }, then: (T) -> Unit) {
    try {
      io.execute {
        val result = try { Result.success(work()) } catch (e: Exception) { Result.failure(e) }
        runOnUiThread {
          if (done || isFinishing) return@runOnUiThread
          result.fold(then) { e ->
            if (e is FillError) {
              if (e.code in RELOCK) Session.clear()
              if (!onError(e)) fail(if (e.code == "network") "Vyre could not reach your vault" else (e.message ?: "vyred refused"))
            } else if (e is VyreException) fail(e.message ?: "Vyre could not finish")
            else fail("Vyre could not finish")
          }
        }
      }
    } catch (e: Exception) { cancel() }
  }

  /** Finish with a result. The one place a value may leave, inside `data`. */
  protected fun finishOk(data: android.content.Intent?) = finishWith(Activity.RESULT_OK, data)

  protected fun finishWith(code: Int, data: android.content.Intent?) {
    if (done) return
    done = true
    if (data != null) setResult(code, data) else setResult(code)
    finish()
  }

  /** Say why, briefly, and give up. Subclasses may put an error into the result first. */
  protected open fun fail(why: String) {
    toast(why)
    cancel()
  }

  protected open fun cancel() {
    if (done) return
    done = true
    setResult(Activity.RESULT_CANCELED)
    finish()
  }

  protected fun toast(s: String) = Toast.makeText(applicationContext, s, Toast.LENGTH_SHORT).show()

  /** What a prompt shows under its title: the site's host or the app's package, never a digest. */
  protected fun originLabel(o: String) = when {
    o.startsWith("android://") -> o.removePrefix("android://").substringBefore('@')
    o.startsWith("android:apk-key-hash:") -> "an app"
    else -> o.substringAfter("://")
  }

  companion object {
    /** Errors after which a new proof is worth one retry. */
    val RELOCK = setOf("session_required", "session_expired", "reprompt")
    /** A card needs a proof younger than vyred's 60 seconds; leave room for the round trip. */
    const val FRESH_MS = 45_000L
  }
}
