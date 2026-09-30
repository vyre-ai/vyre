// The pure half of Vyre autofill on Android: no Android types, so plain JVM JUnit tests cover it
// (android/src/test/java). Everything that decides something lives here:
//
//   - classify(): which kind of field a view is, from what the view says about itself. Order of
//     trust: autofillHints, then the HTML attributes (autocomplete, type, name, id), then the
//     input type flags, then English words in the resource id, the hint and the HTML labels.
//     It never sees a value.
//   - webOrigin() and appOrigin(): the one string a fill is held to (ADR 0028, threat model and
//     decision 6). A web form fills only a login for its exact origin; a native app fills only a
//     login that lists `android:<package>@<sha256 of signing cert>` in its apps.
//   - unlockMessage() and messageToSign(): the device-key challenge. The key signs only a message
//     of the exact shape vyred's challenge route makes, so the key cannot be used to sign
//     anything else, whatever a server sends.
//   - serverUrl(): the vyred address, https only, http://127.0.0.1 in a debug build.

package sh.vyre.autofill

import java.net.URI
import java.security.MessageDigest

/** What a field is for. NEW_PASSWORD is never filled, only saved from. */
enum class Role {
  USERNAME, EMAIL, PASSWORD, NEW_PASSWORD, OTP,
  CARD_NUMBER, CARD_HOLDER, CARD_EXPIRY, CARD_EXP_MONTH, CARD_EXP_YEAR, CARD_CVV,
  NAME, COMPANY, ADDRESS_LINE1, ADDRESS_LINE2, CITY, REGION, POSTAL, COUNTRY, PHONE,
}

/**
 * What a view says about itself, copied out of an AssistStructure.ViewNode by StructureReader.
 * `fillable` is false for a view whose autofill type is NONE. `htmlAttrs` keys are lower case.
 */
data class FieldInfo(
  val fillable: Boolean = true,
  val hints: List<String> = emptyList(),
  val htmlTag: String? = null,
  val htmlAttrs: Map<String, String> = emptyMap(),
  val inputType: Int = 0,
  val idEntry: String? = null,
  val hint: String? = null,
  val maxLength: Int = 0,
)

/** Which fills a form can take, from the roles its fields have. */
data class FormKinds(val login: Boolean, val otp: Boolean, val card: Boolean, val address: Boolean)

object AutofillCore {
  // android.text.InputType, copied so this file needs no Android classes.
  const val TYPE_MASK_CLASS = 0x0000000f
  const val TYPE_MASK_VARIATION = 0x00000ff0
  const val TYPE_CLASS_TEXT = 0x00000001
  const val TYPE_CLASS_NUMBER = 0x00000002
  const val TYPE_TEXT_VARIATION_EMAIL_ADDRESS = 0x00000020
  const val TYPE_TEXT_VARIATION_PASSWORD = 0x00000080
  const val TYPE_TEXT_VARIATION_VISIBLE_PASSWORD = 0x00000090
  const val TYPE_TEXT_VARIATION_WEB_EMAIL_ADDRESS = 0x000000d0
  const val TYPE_TEXT_VARIATION_WEB_PASSWORD = 0x000000e0
  const val TYPE_NUMBER_VARIATION_PASSWORD = 0x00000010

  /** Browsers that get compatibility mode in res/xml/vyre_autofill.xml. A browser never fills by package. */
  val BROWSERS = setOf(
    "com.android.chrome", "com.chrome.beta", "com.chrome.dev", "com.chrome.canary",
    "org.mozilla.firefox", "org.mozilla.firefox_beta", "org.mozilla.fenix", "org.mozilla.focus",
    "com.brave.browser", "com.brave.browser_beta",
    "com.microsoft.emmx", "com.microsoft.emmx.beta",
    "com.sec.android.app.sbrowser", "com.sec.android.app.sbrowser.beta",
  )

  private val SKIP_HTML_TYPES = setOf(
    "hidden", "submit", "button", "reset", "image", "file", "checkbox", "radio", "range",
    "color", "search", "date", "datetime-local", "time", "week", "month",
  )
  private val MODIFIER = Regex("^(section-.*|shipping|billing|home|work|mobile|fax|pager)$")

  // ---- classification -----------------------------------------------------------------------

  /** A field's role, or null when it is not one Vyre fills. */
  fun classify(f: FieldInfo): Role? {
    if (!f.fillable) return null
    val tag = f.htmlTag?.lowercase()
    val htmlType = f.htmlAttrs["type"]?.lowercase()?.trim()
    if (tag != null && tag !in setOf("input", "select", "textarea")) return null
    if (htmlType != null && htmlType in SKIP_HTML_TYPES) return null

    // 1. autofillHints: the app's own words. Unknown hints fall through.
    for (h in f.hints) fromHint(h)?.let { return it }

    // 2. HTML: autocomplete, then type.
    f.htmlAttrs["autocomplete"]?.let { ac ->
      val r = fromAutocomplete(ac)
      if (r === OTHER) return null
      if (r is Role) return r
    }
    val words = words(f)
    if (htmlType == "password") return if (NEW_WORDS.containsMatchIn(words)) Role.NEW_PASSWORD else Role.PASSWORD
    if (htmlType == "email") return Role.EMAIL

    // 3. Input type flags (native views, and web views that report them).
    val cls = f.inputType and TYPE_MASK_CLASS
    val variation = f.inputType and TYPE_MASK_VARIATION
    if (cls == TYPE_CLASS_TEXT) {
      when (variation) {
        TYPE_TEXT_VARIATION_PASSWORD, TYPE_TEXT_VARIATION_WEB_PASSWORD, TYPE_TEXT_VARIATION_VISIBLE_PASSWORD ->
          return if (NEW_WORDS.containsMatchIn(words)) Role.NEW_PASSWORD else if (OTP_WORDS.containsMatchIn(words)) Role.OTP else Role.PASSWORD
        TYPE_TEXT_VARIATION_EMAIL_ADDRESS, TYPE_TEXT_VARIATION_WEB_EMAIL_ADDRESS -> return Role.EMAIL
      }
    }
    if (cls == TYPE_CLASS_NUMBER && variation == TYPE_NUMBER_VARIATION_PASSWORD) {
      // A numeric secret: a one-time code when its words say so, otherwise not ours (a PIN).
      return if (OTP_WORDS.containsMatchIn(words)) Role.OTP else null
    }

    // 4. English words in the id, the hint and the HTML labels.
    return fromWords(words)
  }

  private object Other
  private val OTHER: Any = Other

  /** Android autofill hints (View.AUTOFILL_HINT_*, androidx HintConstants) and HTML tokens given as hints. */
  fun fromHint(hint: String): Role? {
    val h = hint.trim().lowercase().replace(Regex("[\\s_-]"), "")
    return when {
      h == "username" || h == "newusername" -> Role.USERNAME
      h == "emailaddress" || h == "email" -> Role.EMAIL
      h == "password" || h == "currentpassword" -> Role.PASSWORD
      h == "newpassword" -> Role.NEW_PASSWORD
      h == "smsotpcode" || h == "2faappotpcode" || h == "onetimecode" || h.startsWith("smsotpcode") || h == "otp" -> Role.OTP
      h == "creditcardnumber" || h == "ccnumber" -> Role.CARD_NUMBER
      h == "creditcardsecuritycode" || h == "cccsc" -> Role.CARD_CVV
      h == "creditcardexpirationdate" || h == "ccexp" -> Role.CARD_EXPIRY
      h == "creditcardexpirationmonth" || h == "ccexpmonth" -> Role.CARD_EXP_MONTH
      h == "creditcardexpirationyear" || h == "ccexpyear" -> Role.CARD_EXP_YEAR
      h == "ccname" || h == "creditcardholdername" -> Role.CARD_HOLDER
      h == "postaladdress" || h == "streetaddress" || h == "postaladdressstreetaddress" || h == "addressline1" -> Role.ADDRESS_LINE1
      h == "extendedaddress" || h == "postaladdressextendedaddress" || h == "addressline2" -> Role.ADDRESS_LINE2
      h == "addresslocality" || h == "postaladdresslocality" || h == "addresslevel2" -> Role.CITY
      h == "addressregion" || h == "postaladdressregion" || h == "addresslevel1" -> Role.REGION
      h == "postalcode" -> Role.POSTAL
      h == "addresscountry" || h == "postaladdresscountry" || h == "country" || h == "countryname" -> Role.COUNTRY
      h == "phone" || h == "phonenumber" || h == "phonenational" || h == "tel" -> Role.PHONE
      h == "name" || h == "personname" -> Role.NAME
      h == "organization" -> Role.COMPANY
      else -> null
    }
  }

  /** An HTML autocomplete attribute: a Role, OTHER when it names something that is not ours, or null. */
  private fun fromAutocomplete(ac: String): Any? {
    val tokens = ac.lowercase().trim().split(Regex("\\s+")).filter { it.isNotEmpty() && !MODIFIER.matches(it) }
    val last = tokens.lastOrNull() ?: return null
    return when (last) {
      "username" -> Role.USERNAME
      "email" -> Role.EMAIL
      "current-password" -> Role.PASSWORD
      "new-password" -> Role.NEW_PASSWORD
      "one-time-code" -> Role.OTP
      "cc-number" -> Role.CARD_NUMBER
      "cc-name" -> Role.CARD_HOLDER
      "cc-exp" -> Role.CARD_EXPIRY
      "cc-exp-month" -> Role.CARD_EXP_MONTH
      "cc-exp-year" -> Role.CARD_EXP_YEAR
      "cc-csc" -> Role.CARD_CVV
      "name" -> Role.NAME
      "organization" -> Role.COMPANY
      "street-address", "address-line1" -> Role.ADDRESS_LINE1
      "address-line2" -> Role.ADDRESS_LINE2
      "address-level2" -> Role.CITY
      "address-level1" -> Role.REGION
      "postal-code" -> Role.POSTAL
      "country", "country-name" -> Role.COUNTRY
      "tel", "tel-national" -> Role.PHONE
      "on", "off" -> null
      else -> OTHER
    }
  }

  /** Lower case words from the id, the hint and the HTML labels: camelCase split, separators to spaces. */
  fun words(f: FieldInfo): String {
    val parts = listOfNotNull(
      f.idEntry, f.hint,
      f.htmlAttrs["name"], f.htmlAttrs["id"], f.htmlAttrs["placeholder"], f.htmlAttrs["aria-label"], f.htmlAttrs["label"],
    )
    return parts.joinToString(" ") { norm(it) }.trim()
  }

  fun norm(s: String): String =
    s.replace(Regex("([a-z])([A-Z])"), "$1 $2")
      .replace(Regex("([a-zA-Z])(\\d)"), "$1 $2")
      .lowercase()
      .replace(Regex("[_\\-.\\[\\]():*#/]+"), " ")
      .replace(Regex("\\s+"), " ")
      .trim()

  private val NEW_WORDS = Regex("\\b(new|confirm|confirmation|repeat|retype|again|verify password)\\b")
  private val OTP_WORDS = Regex("\\b(otp|totp|one time|onetime|2fa|mfa|two factor|verification code|auth code|authentication code|sms code|security code|passcode)\\b")
  private val CARD_WORDS = Regex("\\b(card|cc|credit|debit|cvv|cvc|csc|expiry|expiration|exp)\\b|cardnumber|ccnum")

  private val RULES: List<Pair<Regex, Role>> = listOf(
    Regex("\\b(cvc|cvv|cvn|csc|card verification|card code)\\b|\\bcvv 2\\b") to Role.CARD_CVV,
    Regex("\\b(name on card|card ?holder|cardholder|holder name|cc name|ccname)\\b") to Role.CARD_HOLDER,
    Regex("\\b(card ?(number|num|no)|cardnumber|cardnum|cc ?(number|num|no)|ccnum|credit card|debit card)\\b") to Role.CARD_NUMBER,
    // "MM/YY" in a placeholder is the whole expiry, not its month.
    Regex("\\bmm ?yy(yy)?\\b") to Role.CARD_EXPIRY,
    Regex("\\b(exp|expiry|expiration|expires)\\b.*\\b(month|mm)\\b|\\bexp month\\b|expmonth|ccmonth") to Role.CARD_EXP_MONTH,
    Regex("\\b(exp|expiry|expiration|expires)\\b.*\\b(year|yy|yyyy)\\b|\\bexp year\\b|expyear|ccyear") to Role.CARD_EXP_YEAR,
    Regex("\\b(expiry|expiration|exp date|expiry date|expiration date|mm yy|mm yyyy)\\b|\\bcc exp\\b") to Role.CARD_EXPIRY,
    Regex("\\b(one time|onetime|otp|totp|2fa|mfa|two factor|verification code|auth code|authentication code|sms code)\\b") to Role.OTP,
    Regex("\\b(new|confirm|repeat|retype) (password|passwd|pwd)\\b") to Role.NEW_PASSWORD,
    Regex("\\b(password|passwd|pwd|pass)\\b") to Role.PASSWORD,
    Regex("\\b(e ?mail|email address)\\b|\\bemail\\b") to Role.EMAIL,
    Regex("\\b(user ?name|username|user ?id|userid|user|login|account|sign in|signin)\\b") to Role.USERNAME,
    Regex("\\b(address ?line ?2|address 2|addr 2|apt|apartment|suite|unit)\\b") to Role.ADDRESS_LINE2,
    Regex("\\b(address ?line ?1|address 1|addr 1|street|address|addr)\\b") to Role.ADDRESS_LINE1,
    Regex("\\b(city|town|locality|suburb)\\b") to Role.CITY,
    Regex("\\b(state|province|region|county)\\b") to Role.REGION,
    Regex("\\b(zip|zip code|zipcode|postal|postcode|post code|postal code)\\b") to Role.POSTAL,
    Regex("\\b(country)\\b") to Role.COUNTRY,
    Regex("\\b(phone|tel|telephone|mobile)\\b") to Role.PHONE,
    Regex("\\b(company|organization|organisation|business name)\\b") to Role.COMPANY,
    Regex("^(full name|name|your name)$|\\bfull name\\b") to Role.NAME,
  )

  /** The role English words name, or null. "security code" is a card's CVV beside card words, else a one-time code. */
  fun fromWords(w: String): Role? {
    if (w.isEmpty()) return null
    if (Regex("\\bsecurity code\\b").containsMatchIn(w)) return if (CARD_WORDS.containsMatchIn(w)) Role.CARD_CVV else Role.OTP
    if (Regex("\\b(search|query|captcha|coupon|promo)\\b").containsMatchIn(w)) return null
    for ((re, role) in RULES) if (re.containsMatchIn(w)) return role
    return null
  }

  private val LOGIN_ROLES = setOf(Role.USERNAME, Role.EMAIL, Role.PASSWORD)
  private val CARD_ROLES = setOf(Role.CARD_NUMBER, Role.CARD_HOLDER, Role.CARD_EXPIRY, Role.CARD_EXP_MONTH, Role.CARD_EXP_YEAR, Role.CARD_CVV)
  private val ADDRESS_ROLES = setOf(Role.NAME, Role.COMPANY, Role.ADDRESS_LINE1, Role.ADDRESS_LINE2, Role.CITY, Role.REGION, Role.POSTAL, Role.COUNTRY, Role.PHONE)

  /**
   * Which fills a form takes. An email field alone is a login's username unless the form is an
   * address form (a street line, or two address fields), where it is the address's email.
   */
  fun kinds(roles: Collection<Role>): FormKinds {
    val addressCount = roles.count { it in ADDRESS_ROLES && it != Role.NAME && it != Role.PHONE }
    val address = Role.ADDRESS_LINE1 in roles || addressCount >= 2
    val login = Role.PASSWORD in roles || Role.USERNAME in roles || (Role.EMAIL in roles && !address)
    return FormKinds(
      login = login,
      otp = Role.OTP in roles,
      card = roles.any { it in CARD_ROLES },
      address = address,
    )
  }

  fun isLoginRole(r: Role) = r in LOGIN_ROLES
  fun isCardRole(r: Role) = r in CARD_ROLES

  /** The address item's field name for a role (core/vault/kinds.js, SPEC.address.fields). */
  fun addressField(r: Role): String? = when (r) {
    Role.NAME -> "name"
    Role.COMPANY -> "company"
    Role.ADDRESS_LINE1 -> "line1"
    Role.ADDRESS_LINE2 -> "line2"
    Role.CITY -> "city"
    Role.REGION -> "region"
    Role.POSTAL -> "postal"
    Role.COUNTRY -> "country"
    Role.PHONE -> "phone"
    Role.EMAIL -> "email"
    else -> null
  }

  /** A four-digit year as a field of `maxLength` wants it: two digits when the field holds two. */
  fun yearFor(year: String, maxLength: Int): String = if (maxLength == 2 && year.length == 4) year.substring(2) else year

  /**
   * The index of the option in a drop-down that means `want` ("07", "2029", "US"), or -1. Compares
   * digits as numbers and words by letters, so "07" finds "7" and "07 - July".
   */
  fun pickOption(options: List<String>, want: String): Int {
    val w = want.trim()
    if (w.isEmpty()) return -1
    val flatW = flat(w)
    options.forEachIndexed { i, o -> if (flat(o) == flatW) return i }
    val num = w.toIntOrNull()
    if (num != null) {
      options.forEachIndexed { i, o ->
        val lead = Regex("^\\s*(\\d{1,4})").find(o)?.groupValues?.get(1)?.toIntOrNull()
        if (lead == num || (lead != null && w.length == 4 && lead == num % 100 && Regex("^\\s*\\d{2}\\b").containsMatchIn(o))) return i
      }
    }
    options.forEachIndexed { i, o -> if (flatW.length >= 2 && flat(o).startsWith(flatW)) return i }
    return -1
  }

  private fun flat(s: String) = s.lowercase().replace(Regex("[^a-z0-9]"), "")

  // ---- origins ------------------------------------------------------------------------------

  private val DOMAIN = Regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\\d{1,5})?$")
  private val PACKAGE = Regex("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+$")
  private val HEX64 = Regex("^[0-9a-f]{64}$")

  /**
   * The origin of a web form: `https://<webDomain>`, or `http://` when the page said so. Null
   * for a domain that is not a host name, or any other scheme. A default port is dropped, as a
   * URL origin drops it.
   */
  fun webOrigin(domain: String?, scheme: String?): String? {
    val d = domain?.trim()?.lowercase()?.trimEnd('.') ?: return null
    if (d.isEmpty() || !DOMAIN.matches(d)) return null
    val s = scheme?.trim()?.lowercase().let { if (it.isNullOrEmpty()) "https" else it }
    if (s != "https" && s != "http") return null
    val host = when {
      s == "https" && d.endsWith(":443") -> d.removeSuffix(":443")
      s == "http" && d.endsWith(":80") -> d.removeSuffix(":80")
      else -> d
    }
    return "$s://$host"
  }

  /** A native app's origin: `android://<package>@<sha256 of its signing certificate, lower hex>`. */
  fun appOrigin(pkg: String?, certSha256: String?): String? {
    if (pkg == null || !PACKAGE.matches(pkg)) return null
    val c = certSha256?.lowercase()?.replace(":", "") ?: return null
    if (!HEX64.matches(c)) return null
    return "android://$pkg@$c"
  }

  /** SHA-256 of a certificate's DER bytes, lower hex. */
  fun certSha256(der: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(der).joinToString("") { "%02x".format(it) }

  fun isWebOrigin(o: String?) = o != null && (o.startsWith("https://") || o.startsWith("http://"))

  // ---- the device-key challenge -------------------------------------------------------------

  private val NONCE = Regex("^[A-Za-z0-9_-]{16,200}$")

  /** What vyred's challenge route asks the device key to sign (core/vault/fill.js, unlockMessage). */
  fun unlockMessage(nonce: String) = "vyre:fill-unlock:v1:$nonce"

  /** The message to sign, or null when the reply is not a well-formed challenge. */
  fun messageToSign(challenge: String?, message: String?): String? {
    if (challenge == null || message == null || !NONCE.matches(challenge)) return null
    return if (message == unlockMessage(challenge)) message else null
  }

  // ---- the vyred address --------------------------------------------------------------------

  /**
   * The fill listener's base URL, normalized (no trailing slash), or null when it is refused:
   * https to any host; http only to 127.0.0.1 and only in a debug build. No user info, query or
   * fragment.
   */
  fun serverUrl(url: String?, debug: Boolean): String? {
    val raw = url?.trim() ?: return null
    val u = try { URI(raw) } catch (e: Exception) { return null }
    val scheme = u.scheme?.lowercase() ?: return null
    val host = u.host?.lowercase() ?: return null
    if (u.rawUserInfo != null || u.rawQuery != null || u.rawFragment != null) return null
    when (scheme) {
      "https" -> {}
      "http" -> if (!(debug && host == "127.0.0.1")) return null
      else -> return null
    }
    val port = if (u.port == -1 || (scheme == "https" && u.port == 443)) "" else ":${u.port}"
    val path = (u.rawPath ?: "").trimEnd('/')
    return "$scheme://$host$port$path"
  }

  /** A route under the fill listener. */
  fun routeUrl(server: String, route: String) = "$server/v1/fill/$route"
}
