// VyreCredentialService: Vyre in Credential Manager (Android 14 and later), for passwords and
// passkeys (ADR 0028, decision 6).
//
// Get: the entries come from vyred's `identities`, which needs a live fill window. With one,
// each login for the caller's exact origin or app, and each passkey for the request's rpId, is an
// entry that opens VyreCredentialActivity. Without one, the sheet shows a single "Unlock Vyre"
// action; the activity unlocks with the device key and hands back the entries.
//
// Create: one "Vyre" entry, which the activity turns into passkey.register or save.
//
// Nothing here logs. Nothing puts a value into an Intent: entries carry an item's name and a
// passkey's credential id (both listable), and the platform adds the request itself.

package sh.vyre.autofill

import android.os.CancellationSignal
import android.os.OutcomeReceiver
import androidx.annotation.RequiresApi
import androidx.credentials.exceptions.ClearCredentialException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.provider.AuthenticationAction
import androidx.credentials.provider.BeginCreateCredentialRequest
import androidx.credentials.provider.BeginCreateCredentialResponse
import androidx.credentials.provider.BeginCreatePasswordCredentialRequest
import androidx.credentials.provider.BeginCreatePublicKeyCredentialRequest
import androidx.credentials.provider.BeginGetCredentialRequest
import androidx.credentials.provider.BeginGetCredentialResponse
import androidx.credentials.provider.CreateEntry
import androidx.credentials.provider.CredentialProviderService
import androidx.credentials.provider.ProviderClearCredentialStateRequest
import org.json.JSONObject
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

@RequiresApi(34)
class VyreCredentialService : CredentialProviderService() {
  private lateinit var pool: ExecutorService

  override fun onCreate() {
    super.onCreate()
    pool = Executors.newCachedThreadPool()
  }

  override fun onDestroy() {
    pool.shutdownNow()
    super.onDestroy()
  }

  override fun onBeginGetCredentialRequest(
    request: BeginGetCredentialRequest,
    cancellationSignal: CancellationSignal,
    callback: OutcomeReceiver<BeginGetCredentialResponse, GetCredentialException>,
  ) {
    val job = pool.submit {
      val response = try { begin(request) } catch (e: Exception) { BeginGetCredentialResponse() }
      if (!cancellationSignal.isCanceled) runCatching { callback.onResult(response) }
    }
    cancellationSignal.setOnCancelListener { job.cancel(true) }
  }

  private fun begin(request: BeginGetCredentialRequest): BeginGetCredentialResponse {
    val paired = VaultStore.paired(this) ?: return BeginGetCredentialResponse()
    val caller = CredentialAccess.caller(this, request.callingAppInfo) ?: return BeginGetCredentialResponse()
    val session = Session.token() ?: return unlockOnly()
    return try {
      val data = FillClient(paired.server, paired.token).post("identities", JSONObject(), session, timeoutMs = 1_500)
      CredentialAccess.response(this, request, caller, CredentialAccess.identities(data))
    } catch (e: FillError) {
      if (e.code in UnlockingActivity.RELOCK) { Session.clear(); unlockOnly() } else BeginGetCredentialResponse()
    }
  }

  /** The one thing to show without a fill window: an action that unlocks and then lists. */
  private fun unlockOnly(): BeginGetCredentialResponse =
    BeginGetCredentialResponse.Builder()
      .addAuthenticationAction(AuthenticationAction("Unlock Vyre", CredentialAccess.pending(this, CredentialAccess.KIND_UNLOCK)))
      .build()

  override fun onBeginCreateCredentialRequest(
    request: BeginCreateCredentialRequest,
    cancellationSignal: CancellationSignal,
    callback: OutcomeReceiver<BeginCreateCredentialResponse, CreateCredentialException>,
  ) {
    val paired = VaultStore.paired(this)
    val supported = request is BeginCreatePasswordCredentialRequest || request is BeginCreatePublicKeyCredentialRequest
    if (paired == null || !supported) { callback.onResult(BeginCreateCredentialResponse()); return }
    val entry = CreateEntry.Builder(paired.name.ifEmpty { "Vyre" }, CredentialAccess.pending(this, CredentialAccess.KIND_CREATE))
      .setDescription("Saved in your Vyre vault")
      .build()
    callback.onResult(BeginCreateCredentialResponse.Builder().addCreateEntry(entry).build())
  }

  override fun onClearCredentialStateRequest(
    request: ProviderClearCredentialStateRequest,
    cancellationSignal: CancellationSignal,
    callback: OutcomeReceiver<Void?, ClearCredentialException>,
  ) {
    // Vyre keeps no per-app sign-in state to clear; the fill window is the vault's, not the app's.
    callback.onResult(null)
  }
}
