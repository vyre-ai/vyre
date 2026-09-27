// VyreAutofillService: Vyre in Android's autofill (ADR 0028, decision 6).
//
// onFillRequest reads the form, works out its origin, and asks vyred which logins match it
// (`match`, names only: a device token, no session). Cards and addresses are listed by `cards`.
// Each item becomes one locked suggestion with no value in it; tapping one runs VyreAuthActivity,
// which proves presence with the device key and fetches the value. The whole request is held
// under BUDGET_MS, well inside the system's limit; on any failure or timeout the service answers
// with no suggestions rather than late.
//
// onSaveRequest offers a typed login to the vault through `save`, which needs a session: with a
// live one it saves now, otherwise the auth activity unlocks first (Android 9 and later).
//
// Nothing here logs, and nothing puts a value into an Intent.

package sh.vyre.autofill

import android.os.Build
import android.os.CancellationSignal
import android.service.autofill.AutofillService
import android.service.autofill.FillCallback
import android.service.autofill.FillRequest
import android.service.autofill.FillResponse
import android.service.autofill.SaveCallback
import android.service.autofill.SaveInfo
import android.service.autofill.SaveRequest
import android.widget.inline.InlinePresentationSpec
import androidx.annotation.RequiresApi
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

@RequiresApi(26)
class VyreAutofillService : AutofillService() {
  private lateinit var pool: ExecutorService

  override fun onCreate() {
    super.onCreate()
    pool = Executors.newCachedThreadPool()
  }

  override fun onDestroy() {
    pool.shutdownNow()
    super.onDestroy()
  }

  override fun onFillRequest(request: FillRequest, cancel: CancellationSignal, callback: FillCallback) {
    val structure = request.fillContexts.lastOrNull()?.structure
    if (structure == null) { callback.onSuccess(null); return }
    val started = System.currentTimeMillis()
    // Exactly one answer: the work's, or the watchdog's empty one past the budget.
    val answered = AtomicBoolean(false)
    val answer = { response: FillResponse? ->
      if (answered.compareAndSet(false, true) && !cancel.isCanceled) {
        try { callback.onSuccess(response) } catch (e: Exception) { /* the request went away */ }
      }
    }
    val job: Future<*> = pool.submit {
      val response = try { respond(request, structure, started) } catch (e: Exception) { null }
      answer(response)
    }
    cancel.setOnCancelListener { answered.set(true); job.cancel(true) }
    pool.submit {
      try { job.get(BUDGET_MS, TimeUnit.MILLISECONDS) } catch (e: Exception) {
        answer(null)
        job.cancel(true)
      }
    }
  }

  private fun respond(request: FillRequest, structure: android.app.assist.AssistStructure, started: Long): FillResponse? {
    val form = StructureReader.read(this, structure)
    val origin = form.origin ?: return null
    if (form.fields.isEmpty()) return null
    val kinds = form.kinds
    val paired = VaultStore.paired(this) ?: return null
    val client = FillClient(paired.server, paired.token)
    val left = { (BUDGET_MS - 300 - (System.currentTimeMillis() - started)).toInt() }

    val inlineSpecs: List<InlinePresentationSpec>
    val inlineMax: Int
    if (Build.VERSION.SDK_INT >= 30 && request.inlineSuggestionsRequest != null) {
      inlineSpecs = request.inlineSuggestionsRequest!!.inlinePresentationSpecs
      inlineMax = request.inlineSuggestionsRequest!!.maxSuggestionCount
    } else { inlineSpecs = emptyList(); inlineMax = 0 }

    val r = FillResponse.Builder()
    var count = 0
    fun add(kind: FillKind, name: String, subtitle: String, ids: List<android.view.autofill.AutofillId>) {
      if (ids.isEmpty()) return
      val inline = if (Build.VERSION.SDK_INT >= 30) Datasets.inline(this, inlineSpecs, inlineMax, count, name, subtitle) else null
      r.addDataset(Datasets.locked(this, ids, name, subtitle, Datasets.authSender(this, kind, name), inline))
      count++
    }

    // Logins and one-time codes: the logins vyred holds for this exact origin.
    if (kinds.login || kinds.otp) {
      val budget = left()
      if (budget > 400) {
        val logins = try {
          client.post("match", JSONObject().put("url", origin), timeoutMs = budget / 2).optJSONArray("logins") ?: JSONArray()
        } catch (e: FillError) { JSONArray() }
        for (i in 0 until logins.length()) {
          val name = logins.optJSONObject(i)?.optString("name")?.takeIf { it.isNotEmpty() } ?: continue
          if (kinds.login) add(FillKind.LOGIN, name, "Vyre login", form.ids(Role.USERNAME, Role.EMAIL, Role.PASSWORD, Role.OTP))
          else add(FillKind.OTP, name, "Vyre one-time code", form.ids(Role.OTP))
        }
      }
    }

    // Cards and addresses: the same list on every page, filled only into a web form (vyred's
    // card.fill and address.fill take an http or https page).
    if ((kinds.card || kinds.address) && form.isWeb) {
      val budget = left()
      if (budget > 400) {
        val listed = try { client.post("cards", JSONObject().put("url", origin), timeoutMs = budget / 2) } catch (e: FillError) { JSONObject() }
        if (kinds.card) {
          val ids = form.fields.filter { AutofillCore.isCardRole(it.role) }.map { it.id }
          names(listed.optJSONArray("cards")).forEach { add(FillKind.CARD, it, "Vyre card", ids) }
        }
        if (kinds.address) {
          val ids = form.fields.filter { AutofillCore.addressField(it.role) != null }.map { it.id }
          names(listed.optJSONArray("addresses")).forEach { add(FillKind.ADDRESS, it, "Vyre address", ids) }
        }
      }
    }

    // Offer to save a typed login. vyred's save route takes a web page only.
    val saveInfo = if (form.isWeb) saveInfo(form) else null
    if (saveInfo != null) r.setSaveInfo(saveInfo)
    if (count == 0 && saveInfo == null) return null
    return r.build()
  }

  private fun names(a: JSONArray?): List<String> {
    if (a == null) return emptyList()
    return (0 until a.length()).mapNotNull { a.optJSONObject(it)?.optString("name")?.takeIf { n -> n.isNotEmpty() } }
  }

  private fun saveInfo(form: ParsedForm): SaveInfo? {
    val passwords = form.ids(Role.PASSWORD, Role.NEW_PASSWORD)
    if (passwords.isEmpty()) return null
    val users = form.ids(Role.USERNAME, Role.EMAIL)
    val type = SaveInfo.SAVE_DATA_TYPE_PASSWORD or (if (users.isNotEmpty()) SaveInfo.SAVE_DATA_TYPE_USERNAME else 0)
    val b = SaveInfo.Builder(type, passwords.toTypedArray())
    if (users.isNotEmpty()) b.setOptionalIds(users.toTypedArray())
    // A web login often ends by navigating away: save when the fields disappear.
    b.setFlags(SaveInfo.FLAG_SAVE_ON_ALL_VIEWS_INVISIBLE)
    return b.build()
  }

  override fun onSaveRequest(request: SaveRequest, callback: SaveCallback) {
    val structure = request.fillContexts.lastOrNull()?.structure
    if (structure == null) { callback.onFailure("Vyre could not read the form"); return }
    pool.submit {
      try {
        val form = StructureReader.read(this, structure)
        val origin = form.origin
        if (origin == null || !form.isWeb) { callback.onFailure("Vyre saves logins from web pages only for now"); return@submit }
        val password = form.of(Role.NEW_PASSWORD).firstNotNullOfOrNull { StructureReader.valueOf(it)?.takeIf { v -> v.isNotEmpty() } }
          ?: form.of(Role.PASSWORD).firstNotNullOfOrNull { StructureReader.valueOf(it)?.takeIf { v -> v.isNotEmpty() } }
        if (password == null) { callback.onFailure("There was no password to save"); return@submit }
        val username = form.of(Role.USERNAME, Role.EMAIL).firstNotNullOfOrNull { StructureReader.valueOf(it)?.takeIf { v -> v.isNotEmpty() } } ?: ""
        val paired = VaultStore.paired(this)
        if (paired == null) { callback.onFailure("Pair this phone in the Vyre app first"); return@submit }
        val session = Session.token()
        if (session != null) {
          try {
            FillClient(paired.server, paired.token).post("save", saveBody(origin, username, password), session, timeoutMs = 8_000)
            callback.onSuccess()
            return@submit
          } catch (e: FillError) {
            if (e.code != "session_expired" && e.code != "session_required") { callback.onFailure("Vyre did not save: ${e.message}"); return@submit }
            Session.clear()
          }
        }
        if (Build.VERSION.SDK_INT >= 28) {
          val id = PendingSaves.put(origin, username, password)
          callback.onSuccess(Datasets.authSender(this, FillKind.SAVE, null, id))
        } else {
          callback.onFailure("Unlock Vyre, then save again")
        }
      } catch (e: Exception) {
        try { callback.onFailure("Vyre could not save this login") } catch (x: Exception) {}
      }
    }
  }

  companion object {
    /** The whole fill request, match and cards together, answered inside this. */
    const val BUDGET_MS = 2_800L

    fun saveBody(url: String, username: String, password: String): JSONObject =
      JSONObject().put("url", url).put("password", password).apply { if (username.isNotEmpty()) put("username", username) }
  }
}
