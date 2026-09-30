// VyreAuthActivity: the one tap behind every Vyre autofill suggestion.
//
//   1. With no live fill window, UnlockingActivity opens one with the device key. A card always
//      asks for a fresh proof: vyred fills a card only within 60 seconds of one
//      (core/vault/fill-cards.js, REPROMPT_MS).
//   2. POST fill, otp, card.fill or address.fill for the item's name and the form's origin. The
//      origin is read here, from the AssistStructure the framework attached, never from an extra.
//   3. Hand the values back as a Dataset through EXTRA_AUTHENTICATION_RESULT and finish.
//
// For a save, the login waits in PendingSaves under the id in the Intent; after the unlock it
// goes to POST save. The screen is translucent: the person sees the system's biometric sheet
// over the app they were in, and a short toast when something fails. Nothing is logged.

package sh.vyre.autofill

import android.app.assist.AssistStructure
import android.content.Intent
import android.os.Bundle
import android.service.autofill.Dataset
import android.view.autofill.AutofillManager
import androidx.annotation.RequiresApi
import org.json.JSONObject

@RequiresApi(26)
class VyreAuthActivity : UnlockingActivity() {
  private lateinit var kind: FillKind
  private var name: String? = null
  private var form: ParsedForm? = null
  private var paired: Paired? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
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
    unlock(fresh = kind == FillKind.CARD) { proceed(retried = false) }
  }

  private fun unlock(fresh: Boolean, then: (String) -> Unit) =
    withSession(client(), title(), form?.origin?.let { originLabel(it) } ?: paired?.name ?: "", fresh, then)

  private fun title() = if (kind == FillKind.SAVE) "Save to Vyre" else "Fill $name from Vyre"

  private fun proceed(retried: Boolean) {
    val session = Session.token() ?: return unlock(kind == FillKind.CARD) { proceed(retried) }
    val client = client()
    if (kind == FillKind.SAVE) {
      val held = PendingSaves.take(intent.getStringExtra(Datasets.EXTRA_SAVE_ID)) ?: return fail("the login to save went away; submit the form again")
      background({ client.post("save", VyreAutofillService.saveBody(held.url, held.username, held.password), session) }) { r ->
        val saved = r.optString("name", "")
        toast(if (r.optBoolean("created")) "Saved to Vyre as $saved" else if (r.optBoolean("updated")) "Updated $saved in Vyre" else "$saved is already in Vyre")
        finishOk(null)
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
        unlock(fresh = true) { proceed(retried = true) }
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
      val ds: Dataset = d.build() ?: return@background fail("$name has nothing for these fields")
      finishOk(Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, ds))
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

  private fun client(): FillClient = paired!!.let { FillClient(it.server, it.token) }
}
