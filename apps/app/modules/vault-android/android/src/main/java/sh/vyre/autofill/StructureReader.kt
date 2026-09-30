// Reads an AssistStructure into the fields Vyre fills and the origin they are held to.
//
// The origin (ADR 0028, threat model and decision 6):
//   - A node with a web domain is a web form. The origin is `https://<webDomain>` (or the
//     page's own http scheme on Android 9 and later), and only fields under that same domain
//     are kept, so a form in another site's frame is left alone.
//   - With no web domain anywhere, the form belongs to the calling app. Its origin is
//     `android://<package>@<sha256 of its one signing certificate>`. An app signed by more than
//     one certificate gets no origin, and so no fill.
//   - A browser never falls back to its package: with no web domain it gets no origin.
//
// It reads what fields say about themselves. Values are read only for a save, by valueOf().

package sh.vyre.autofill

import android.app.assist.AssistStructure
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.view.View
import android.view.autofill.AutofillId
import android.view.autofill.AutofillValue
import androidx.annotation.RequiresApi

data class ParsedField(
  val id: AutofillId,
  val role: Role,
  val autofillType: Int,
  val options: List<String>,
  val maxLength: Int,
  val focused: Boolean,
  val node: AssistStructure.ViewNode,
)

data class ParsedForm(
  /** The exact origin this form is held to, or null when it has none (no fill, no save). */
  val origin: String?,
  val fields: List<ParsedField>,
  val packageName: String,
) {
  val roles: List<Role> get() = fields.map { it.role }
  val kinds: FormKinds get() = AutofillCore.kinds(roles)
  val isWeb: Boolean get() = AutofillCore.isWebOrigin(origin)
  fun ids(vararg roles: Role): List<AutofillId> = fields.filter { it.role in roles }.map { it.id }
  fun of(vararg roles: Role): List<ParsedField> = fields.filter { it.role in roles }
}

@RequiresApi(26)
object StructureReader {
  private class Raw(val node: AssistStructure.ViewNode, val domain: String?, val scheme: String?)

  fun read(context: Context, structure: AssistStructure): ParsedForm {
    val pkg = structure.activityComponent?.packageName ?: ""
    val raws = ArrayList<Raw>()
    val seen = LinkedHashMap<String, String?>()
    for (i in 0 until structure.windowNodeCount) {
      walk(structure.getWindowNodeAt(i).rootViewNode, null, null, raws, seen)
    }

    // Classify every node that can take a value.
    val classified = raws.mapNotNull { r ->
      val id = r.node.autofillId ?: return@mapNotNull null
      val role = AutofillCore.classify(describe(r.node)) ?: return@mapNotNull null
      Triple(r, id, role)
    }

    val webDomains = seen.keys
    val origin: String?
    val kept: List<Triple<Raw, AutofillId, Role>>
    if (webDomains.isNotEmpty()) {
      // The focused field's domain decides; failing that, the first classified field's.
      val lead = classified.firstOrNull { it.first.node.isFocused && it.first.domain != null }
        ?: classified.firstOrNull { it.first.domain != null }
      if (lead != null) {
        val domain = lead.first.domain
        origin = AutofillCore.webOrigin(domain, lead.first.scheme)
        kept = classified.filter { it.first.domain == domain }
      } else if (webDomains.size == 1) {
        // Compatibility mode: the framework puts the page's domain on the browser's URL bar, not
        // above the fields. One domain in the whole window is unambiguous; more than one is not.
        val (domain, scheme) = seen.entries.first()
        origin = AutofillCore.webOrigin(domain, scheme)
        kept = classified
      } else {
        origin = null
        kept = emptyList()
      }
    } else if (pkg in AutofillCore.BROWSERS || pkg == context.packageName) {
      origin = null
      kept = emptyList()
    } else {
      origin = AutofillCore.appOrigin(pkg, signingCertSha256(context, pkg))
      kept = classified
    }

    val fields = kept.map { (r, id, role) ->
      val n = r.node
      ParsedField(
        id = id, role = role, autofillType = n.autofillType,
        options = n.autofillOptions?.map { it.toString() } ?: emptyList(),
        maxLength = maxLength(n), focused = n.isFocused, node = n,
      )
    }
    return ParsedForm(origin, fields, pkg)
  }

  private fun walk(n: AssistStructure.ViewNode, domain: String?, scheme: String?, out: MutableList<Raw>, seen: MutableMap<String, String?>) {
    val own = n.webDomain?.takeIf { it.isNotBlank() }
    val d = own ?: domain
    val s = if (own != null) (if (Build.VERSION.SDK_INT >= 28) n.webScheme else null) else scheme
    if (own != null && own !in seen) seen[own] = s
    if (n.autofillType != View.AUTOFILL_TYPE_NONE && n.visibility == View.VISIBLE) out.add(Raw(n, d, s))
    for (i in 0 until n.childCount) walk(n.getChildAt(i), d, s, out, seen)
  }

  /** What a node says about itself, as the pure classifier takes it. */
  fun describe(n: AssistStructure.ViewNode): FieldInfo {
    val attrs = HashMap<String, String>()
    n.htmlInfo?.attributes?.forEach { p ->
      val k = p.first?.lowercase() ?: return@forEach
      val v = p.second ?: return@forEach
      if (k in setOf("type", "name", "id", "autocomplete", "placeholder", "aria-label", "label", "maxlength")) attrs[k] = v
    }
    return FieldInfo(
      fillable = n.autofillType != View.AUTOFILL_TYPE_NONE,
      hints = n.autofillHints?.toList() ?: emptyList(),
      htmlTag = n.htmlInfo?.tag,
      htmlAttrs = attrs,
      inputType = n.inputType,
      idEntry = n.idEntry,
      hint = n.hint,
      maxLength = maxLength(n),
    )
  }

  private fun maxLength(n: AssistStructure.ViewNode): Int {
    n.htmlInfo?.attributes?.firstOrNull { it.first.equals("maxlength", true) }?.second?.toIntOrNull()?.let { return it }
    return if (Build.VERSION.SDK_INT >= 28) n.maxTextLength.coerceAtLeast(0) else 0
  }

  /**
   * SHA-256 of an app's one signing certificate, lower hex, or null (not installed, or more than
   * one signer: then a package plus one digest does not name it).
   */
  fun signingCertSha256(context: Context, pkg: String): String? {
    if (pkg.isEmpty()) return null
    return try {
      val pm = context.packageManager
      val certs = if (Build.VERSION.SDK_INT >= 28) {
        val info = pm.getPackageInfo(pkg, PackageManager.GET_SIGNING_CERTIFICATES)
        val si = info.signingInfo ?: return null
        if (si.hasMultipleSigners()) return null
        si.apkContentsSigners
      } else {
        @Suppress("DEPRECATION")
        pm.getPackageInfo(pkg, PackageManager.GET_SIGNATURES).signatures
      }
      if (certs == null || certs.size != 1) null else AutofillCore.certSha256(certs[0].toByteArray())
    } catch (e: Exception) {
      null
    }
  }

  /** A text field's value, for a save only. */
  fun valueOf(f: ParsedField): String? {
    val v: AutofillValue = f.node.autofillValue ?: return null
    return if (v.isText) v.textValue?.toString() else null
  }
}
