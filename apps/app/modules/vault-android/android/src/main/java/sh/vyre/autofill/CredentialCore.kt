// The pure half of Vyre in Credential Manager (Android 14 and later): no Android types, tested
// on the plain JVM (android/src/test/java). It decides:
//
//   - the caller's origin: a privileged browser's web origin (CallingAppInfo.getOrigin with
//     Google's allowlist), or an app's `android:apk-key-hash:<base64url sha256 of its cert>`, the
//     origin WebAuthn gives an Android app;
//   - which vault logins a caller may see: a web origin must be one of the login's sites, an app
//     must be listed in its apps as `android:<package>@<sha256>` (ADR 0028, decision 6);
//   - whether a caller may use a passkey's rpId: a web origin's host is the rpId or under it; an
//     app needs the rpId's Digital Asset Links to name its package and certificate;
//   - the clientDataJSON Vyre builds for an app caller, and the PublicKeyCredential JSON the
//     platform takes back, in the WebAuthn toJSON() shape.
//
// It writes JSON by hand (org.json is an Android class), escaping every string.

package sh.vyre.autofill

import java.security.MessageDigest

/** Who is asking, as CallingAppInfo says it. `webOrigin` is set only for an allowlisted browser. */
data class Caller(val packageName: String, val certSha256Hex: String?, val webOrigin: String?)

/** One Digital Asset Links statement, reduced to what the check reads. */
data class AssetStatement(val relations: List<String>, val namespace: String?, val packageName: String?, val fingerprints: List<String>)

object CredentialCore {
  const val APK_KEY_HASH = "android:apk-key-hash:"
  /** Relations that let an app use a site's credentials. */
  val LOGIN_RELATIONS = setOf("delegate_permission/common.get_login_creds", "delegate_permission/common.handle_all_urls")

  // ---- bytes ----

  private const val B64U = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

  /** base64url without padding (RFC 4648 section 5). */
  fun b64url(b: ByteArray): String {
    val out = StringBuilder((b.size * 4 + 2) / 3)
    var i = 0
    while (i + 3 <= b.size) {
      val n = (b[i].toInt() and 0xff shl 16) or (b[i + 1].toInt() and 0xff shl 8) or (b[i + 2].toInt() and 0xff)
      out.append(B64U[n shr 18 and 63]).append(B64U[n shr 12 and 63]).append(B64U[n shr 6 and 63]).append(B64U[n and 63])
      i += 3
    }
    val rest = b.size - i
    if (rest == 1) {
      val n = b[i].toInt() and 0xff shl 16
      out.append(B64U[n shr 18 and 63]).append(B64U[n shr 12 and 63])
    } else if (rest == 2) {
      val n = (b[i].toInt() and 0xff shl 16) or (b[i + 1].toInt() and 0xff shl 8)
      out.append(B64U[n shr 18 and 63]).append(B64U[n shr 12 and 63]).append(B64U[n shr 6 and 63])
    }
    return out.toString()
  }

  fun sha256(b: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(b)

  /** Lower hex (colons allowed) to bytes, or null. */
  fun hexBytes(hex: String?): ByteArray? {
    val h = hex?.replace(":", "")?.lowercase() ?: return null
    if (h.isEmpty() || h.length % 2 != 0 || !h.all { it in '0'..'9' || it in 'a'..'f' }) return null
    return ByteArray(h.length / 2) { ((Character.digit(h[it * 2], 16) shl 4) or Character.digit(h[it * 2 + 1], 16)).toByte() }
  }

  private fun normHex(h: String?) = h?.replace(":", "")?.lowercase()

  // ---- origins ----

  /** An app's WebAuthn origin from its certificate's SHA-256 (hex). */
  fun apkKeyHashOrigin(certSha256Hex: String?): String? {
    val b = hexBytes(certSha256Hex) ?: return null
    if (b.size != 32) return null
    return APK_KEY_HASH + b64url(b)
  }

  /** A web origin as vyred compares it: scheme://host[:port], no trailing slash. */
  fun normalWebOrigin(o: String?): String? {
    val s = o?.trim()?.trimEnd('/')?.lowercase() ?: return null
    return if (Regex("^https://[a-z0-9.-]+(:\\d{1,5})?$").matches(s) || Regex("^http://localhost(:\\d{1,5})?$").matches(s)) s else null
  }

  /** The origin a caller's clientDataJSON carries. */
  fun callerOrigin(c: Caller): String? = normalWebOrigin(c.webOrigin) ?: apkKeyHashOrigin(c.certSha256Hex)

  /** The `url` vyred's fill routes take for this caller: the web origin, or android://<pkg>@<sha256>. */
  fun fillUrl(c: Caller): String? =
    if (c.webOrigin != null) normalWebOrigin(c.webOrigin) else AutofillCore.appOrigin(c.packageName, normHex(c.certSha256Hex))

  /** How a login's `apps` names an app (core/vault/fill.js appOf). */
  fun appKey(pkg: String, certSha256Hex: String?): String? {
    val h = normHex(certSha256Hex) ?: return null
    return if (AutofillCore.appOrigin(pkg, h) != null) "android:${pkg.lowercase()}@$h" else null
  }

  /** A login is offered to this caller only for its exact origin or its exact app. */
  fun loginFor(sites: List<String>, apps: List<String>, c: Caller): Boolean {
    if (c.webOrigin != null) {
      val o = normalWebOrigin(c.webOrigin) ?: return false
      return sites.any { normalWebOrigin(it) == o }
    }
    val key = appKey(c.packageName, c.certSha256Hex) ?: return false
    return apps.any { it.lowercase() == key }
  }

  // ---- relying parties ----

  private val RP = Regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$")

  /** An rpId that is a domain name with at least one dot, not an IP literal. */
  fun validRpId(rpId: String?): Boolean {
    val r = rpId?.lowercase() ?: return false
    if (!RP.matches(r)) return false
    return !Regex("^\\d+(\\.\\d+){3}$").matches(r)
  }

  /** A web origin may use an rpId that is its host or a parent of it. */
  fun rpAllowedForWeb(rpId: String?, origin: String?): Boolean {
    val o = normalWebOrigin(origin) ?: return false
    val r = rpId?.lowercase() ?: return false
    if (!validRpId(r) && !(r == "localhost" && o.startsWith("http://localhost"))) return false
    val host = o.substringAfter("://").substringBefore(':')
    return host == r || host.endsWith(".$r")
  }

  /** The rpId a request means: its own, or the web origin's host when it gives none. */
  fun rpIdFor(requested: String?, c: Caller): String? {
    val r = requested?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }
    if (r != null) return r
    val o = normalWebOrigin(c.webOrigin) ?: return null
    return o.substringAfter("://").substringBefore(':')
  }

  /** The site's assetlinks.json lets this app use its credentials. */
  fun assetLinksAllow(statements: List<AssetStatement>, pkg: String, certSha256Hex: String?): Boolean {
    val want = normHex(certSha256Hex) ?: return false
    return statements.any { s ->
      s.relations.any { it in LOGIN_RELATIONS } && s.namespace == "android_app" && s.packageName == pkg &&
        s.fingerprints.any { normHex(it) == want }
    }
  }

  /** May this caller use a passkey for rpId? An app's answer also needs its asset links, fetched by the caller of this. */
  fun rpAllowed(rpId: String?, c: Caller, assetLinks: List<AssetStatement>?): Boolean {
    if (!validRpId(rpId) && c.webOrigin == null) return false
    if (c.webOrigin != null) return rpAllowedForWeb(rpId, c.webOrigin)
    return assetLinks != null && assetLinksAllow(assetLinks, c.packageName, c.certSha256Hex)
  }

  // ---- JSON ----

  /** A JSON string literal. */
  fun jsonString(s: String): String {
    val b = StringBuilder(s.length + 2).append('"')
    for (ch in s) {
      when (ch) {
        '"' -> b.append("\\\"")
        '\\' -> b.append("\\\\")
        '\n' -> b.append("\\n")
        '\r' -> b.append("\\r")
        '\t' -> b.append("\\t")
        '\b' -> b.append("\\b")
        '\u000C' -> b.append("\\f")
        else -> if (ch < ' ' || ch == ' ' || ch == ' ') b.append("\\u%04x".format(ch.code)) else b.append(ch)
      }
    }
    return b.append('"').toString()
  }

  private fun obj(vararg kv: Pair<String, String?>): String =
    kv.filter { it.second != null }.joinToString(",", "{", "}") { "${jsonString(it.first)}:${it.second}" }

  private fun str(s: String?) = s?.let { jsonString(it) }

  /**
   * clientDataJSON as WebAuthn serializes it: type, challenge, origin, crossOrigin, in that
   * order, and for an app caller the package name Android adds. `type` is "webauthn.get" or
   * "webauthn.create"; `challenge` is the request's base64url challenge, as given.
   */
  fun clientDataJson(type: String, challenge: String, origin: String, androidPackageName: String? = null): String =
    obj(
      "type" to str(type),
      "challenge" to str(challenge),
      "origin" to str(origin),
      "crossOrigin" to "false",
      "androidPackageName" to str(androidPackageName),
    )

  /** The hash vyred signs over: the platform's when it gave one, else ours of our clientDataJSON. */
  fun clientDataHash(platformHash: ByteArray?, clientDataJson: String): ByteArray =
    if (platformHash != null && platformHash.size == 32) platformHash else sha256(clientDataJson.toByteArray(Charsets.UTF_8))

  /** A PublicKeyCredential (assertion) in the toJSON() shape Credential Manager takes. */
  fun assertionJson(credentialId: String, clientDataJsonB64u: String, authenticatorData: String, signature: String, userHandle: String?): String =
    obj(
      "id" to str(credentialId),
      "rawId" to str(credentialId),
      "type" to str("public-key"),
      "authenticatorAttachment" to str("platform"),
      "response" to obj(
        "clientDataJSON" to str(clientDataJsonB64u),
        "authenticatorData" to str(authenticatorData),
        "signature" to str(signature),
        "userHandle" to str(userHandle?.takeIf { it.isNotEmpty() }),
      ),
      "clientExtensionResults" to "{}",
    )

  /** A PublicKeyCredential (registration) in the toJSON() shape. ES256 only, as vyred makes. */
  fun registrationJson(credentialId: String, clientDataJsonB64u: String, attestationObject: String, authenticatorData: String?, publicKey: String?): String =
    obj(
      "id" to str(credentialId),
      "rawId" to str(credentialId),
      "type" to str("public-key"),
      "authenticatorAttachment" to str("platform"),
      "response" to obj(
        "clientDataJSON" to str(clientDataJsonB64u),
        "attestationObject" to str(attestationObject),
        "authenticatorData" to str(authenticatorData),
        "publicKey" to str(publicKey),
        "publicKeyAlgorithm" to if (publicKey != null) "-7" else null,
        "transports" to "[\"internal\",\"hybrid\"]",
      ),
      "clientExtensionResults" to "{\"credProps\":{\"rk\":true}}",
    )
}
