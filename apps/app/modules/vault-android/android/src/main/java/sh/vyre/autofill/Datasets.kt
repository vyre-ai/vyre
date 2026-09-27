// Datasets: what the suggestion strip shows, and what a finished fill hands back.
//
// A suggestion carries a name and no value. Each one is locked behind setAuthentication(), an
// IntentSender for VyreAuthActivity with the item's name and kind as its only extras. The
// framework adds the AssistStructure when it fires, and the activity reads the origin from that,
// not from anything the service put in the Intent. The values appear only in the Dataset the
// activity returns through EXTRA_AUTHENTICATION_RESULT.

package sh.vyre.autofill

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.IntentSender
import android.os.Build
import android.service.autofill.Dataset
import android.service.autofill.InlinePresentation
import android.view.autofill.AutofillId
import android.view.autofill.AutofillValue
import android.widget.RemoteViews
import android.widget.inline.InlinePresentationSpec
import androidx.annotation.RequiresApi
import androidx.autofill.inline.UiVersions
import androidx.autofill.inline.v1.InlineSuggestionUi
import java.util.concurrent.atomic.AtomicInteger

enum class FillKind(val wire: String) {
  LOGIN("login"), OTP("otp"), CARD("card"), ADDRESS("address"), SAVE("save");
  companion object { fun of(s: String?) = values().firstOrNull { it.wire == s } }
}

@RequiresApi(26)
object Datasets {
  const val EXTRA_KIND = "sh.vyre.autofill.KIND"
  const val EXTRA_NAME = "sh.vyre.autofill.NAME"
  const val EXTRA_SAVE_ID = "sh.vyre.autofill.SAVE_ID"

  private val requestCodes = AtomicInteger((System.currentTimeMillis() and 0xffff).toInt())

  fun presentation(context: Context, title: String, subtitle: String): RemoteViews =
    RemoteViews(context.packageName, R.layout.vyre_autofill_item).apply {
      setTextViewText(R.id.vyre_autofill_title, title)
      setTextViewText(R.id.vyre_autofill_subtitle, subtitle)
    }

  /**
   * The IntentSender a locked suggestion (or a save that needs an unlock) fires. Mutable, because
   * the framework fills in EXTRA_ASSIST_STRUCTURE; explicit, to a non-exported activity of ours.
   * Each gets its own request code so their extras never collapse into one.
   */
  fun authSender(context: Context, kind: FillKind, name: String?, saveId: String? = null): IntentSender {
    val i = Intent(context, VyreAuthActivity::class.java)
      .putExtra(EXTRA_KIND, kind.wire)
      .apply { if (name != null) putExtra(EXTRA_NAME, name) }
      .apply { if (saveId != null) putExtra(EXTRA_SAVE_ID, saveId) }
    val flags = PendingIntent.FLAG_CANCEL_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
    return PendingIntent.getActivity(context, requestCodes.incrementAndGet(), i, flags).intentSender
  }

  /**
   * A locked suggestion over `ids`: the name shows, no value is in it. `inline` is the keyboard's
   * chip on Android 11 and later, or null.
   */
  @SuppressLint("NewApi")
  @Suppress("DEPRECATION")
  fun locked(context: Context, ids: List<AutofillId>, title: String, subtitle: String, auth: IntentSender, inline: InlinePresentation?): Dataset {
    val b = Dataset.Builder()
    val p = presentation(context, title, subtitle)
    for (id in ids) {
      if (inline != null && Build.VERSION.SDK_INT >= 30) b.setValue(id, null, p, inline)
      else b.setValue(id, null, p)
    }
    b.setAuthentication(auth)
    return b.build()
  }

  /** The keyboard chip for suggestion `index`, when the keyboard asked for chips and has room. */
  @RequiresApi(30)
  fun inline(context: Context, specs: List<InlinePresentationSpec>, max: Int, index: Int, title: String, subtitle: String): InlinePresentation? {
    if (specs.isEmpty() || index >= max) return null
    val spec = specs[minOf(index, specs.size - 1)]
    if (!UiVersions.getVersions(spec.style).contains(UiVersions.INLINE_UI_VERSION_1)) return null
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: Intent()
    val attribution = PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_IMMUTABLE)
    val slice = InlineSuggestionUi.newContentBuilder(attribution)
      .setTitle(title)
      .setSubtitle(subtitle)
      .setContentDescription("$title, $subtitle")
      .build().slice
    return InlinePresentation(slice, spec, false)
  }

  /** A filled Dataset: the one place a value goes into something that leaves this process. */
  @Suppress("DEPRECATION")
  class Filled(private val context: Context) {
    private val b = Dataset.Builder(presentation(context, "Vyre", ""))
    var count = 0
      private set

    fun text(id: AutofillId, value: String?) {
      if (value.isNullOrEmpty()) return
      b.setValue(id, AutofillValue.forText(value)); count++
    }

    /** A field of any type: text, a drop-down (by matching option), or nothing. */
    fun any(f: ParsedField, value: String?) {
      if (value.isNullOrEmpty()) return
      when (f.autofillType) {
        android.view.View.AUTOFILL_TYPE_TEXT -> text(f.id, value)
        android.view.View.AUTOFILL_TYPE_LIST -> {
          val i = AutofillCore.pickOption(f.options, value)
          if (i >= 0) { b.setValue(f.id, AutofillValue.forList(i)); count++ }
        }
        else -> {}
      }
    }

    fun build(): Dataset? = if (count == 0) null else b.build()
  }
}
