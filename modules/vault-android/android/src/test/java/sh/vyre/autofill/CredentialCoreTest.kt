// Plain JVM tests for CredentialCore: base64url, caller origins, which logins and passkeys a
// caller may see, asset links, and the JSON Credential Manager takes. Sample world only.

package sh.vyre.autofill

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CredentialCoreTest {
  private val cert = "ab".repeat(32)
  private val app = Caller("test.harlow.portal", cert, null)
  private val chrome = Caller("com.android.chrome", "cd".repeat(32), "https://portal.harlow.test")

  @Test fun base64url() {
    assertEquals("", CredentialCore.b64url(ByteArray(0)))
    assertEquals("Zg", CredentialCore.b64url("f".toByteArray()))
    assertEquals("Zm8", CredentialCore.b64url("fo".toByteArray()))
    assertEquals("Zm9v", CredentialCore.b64url("foo".toByteArray()))
    assertEquals("Zm9vYmFy", CredentialCore.b64url("foobar".toByteArray()))
    assertEquals("-_8", CredentialCore.b64url(byteArrayOf(0xfb.toByte(), 0xff.toByte())))
  }

  @Test fun hex() {
    assertArrayEquals(byteArrayOf(0xab.toByte(), 0x01), CredentialCore.hexBytes("AB:01"))
    assertNull(CredentialCore.hexBytes("abc"))
    assertNull(CredentialCore.hexBytes("zz"))
    assertNull(CredentialCore.hexBytes(null))
  }

  @Test fun callerOrigins() {
    // 32 bytes of 0xab, base64url: "q6ur" repeated, 43 characters.
    val expected = "android:apk-key-hash:" + CredentialCore.b64url(ByteArray(32) { 0xab.toByte() })
    assertEquals(expected, CredentialCore.callerOrigin(app))
    assertEquals(43, expected.removePrefix("android:apk-key-hash:").length)
    assertEquals("https://portal.harlow.test", CredentialCore.callerOrigin(chrome))
    assertEquals("https://portal.harlow.test", CredentialCore.callerOrigin(chrome.copy(webOrigin = "https://portal.harlow.test/")))
    assertNull(CredentialCore.apkKeyHashOrigin("abcd"))
    assertEquals("android://test.harlow.portal@$cert", CredentialCore.fillUrl(app))
    assertEquals("https://portal.harlow.test", CredentialCore.fillUrl(chrome))
    assertEquals("android:test.harlow.portal@$cert", CredentialCore.appKey("test.harlow.portal", cert.uppercase()))
  }

  @Test fun loginsForExactOriginOrApp() {
    val sites = listOf("https://portal.harlow.test")
    val apps = listOf("android:test.harlow.portal@$cert")
    assertTrue(CredentialCore.loginFor(sites, emptyList(), chrome))
    assertFalse(CredentialCore.loginFor(listOf("https://harlow.test"), emptyList(), chrome))
    assertFalse(CredentialCore.loginFor(sites, emptyList(), chrome.copy(webOrigin = "https://portal.harlow.test.northwind.test")))
    assertTrue(CredentialCore.loginFor(emptyList(), apps, app))
    assertFalse("another certificate is another app", CredentialCore.loginFor(emptyList(), apps, app.copy(certSha256Hex = "cd".repeat(32))))
    assertFalse("a site login is not an app login", CredentialCore.loginFor(sites, emptyList(), app))
    assertFalse(CredentialCore.loginFor(emptyList(), apps, app.copy(certSha256Hex = null)))
  }

  @Test fun relyingParties() {
    assertTrue(CredentialCore.rpAllowedForWeb("harlow.test", "https://portal.harlow.test"))
    assertTrue(CredentialCore.rpAllowedForWeb("portal.harlow.test", "https://portal.harlow.test"))
    assertFalse(CredentialCore.rpAllowedForWeb("northwind.test", "https://portal.harlow.test"))
    assertFalse(CredentialCore.rpAllowedForWeb("low.test", "https://portal.harlow.test"))
    assertFalse(CredentialCore.rpAllowedForWeb("harlow.test", "http://portal.harlow.test"))
    assertFalse(CredentialCore.rpAllowedForWeb("test", "https://portal.harlow.test"))
    assertFalse(CredentialCore.validRpId("10.0.0.1"))
    assertEquals("portal.harlow.test", CredentialCore.rpIdFor(null, chrome))
    assertEquals("harlow.test", CredentialCore.rpIdFor("Harlow.Test", chrome))
    assertNull(CredentialCore.rpIdFor(null, app))
  }

  @Test fun assetLinks() {
    val fp = "AB:".repeat(31) + "AB"
    val good = AssetStatement(listOf("delegate_permission/common.get_login_creds"), "android_app", "test.harlow.portal", listOf(fp))
    assertTrue(CredentialCore.assetLinksAllow(listOf(good), "test.harlow.portal", cert))
    assertFalse(CredentialCore.assetLinksAllow(listOf(good.copy(packageName = "test.northwind.app")), "test.harlow.portal", cert))
    assertFalse(CredentialCore.assetLinksAllow(listOf(good.copy(fingerprints = listOf("CD:".repeat(31) + "CD"))), "test.harlow.portal", cert))
    assertFalse(CredentialCore.assetLinksAllow(listOf(good.copy(relations = listOf("delegate_permission/common.use_as_origin"))), "test.harlow.portal", cert))
    assertFalse(CredentialCore.assetLinksAllow(listOf(good.copy(namespace = "web")), "test.harlow.portal", cert))
    assertTrue(CredentialCore.rpAllowed("harlow.test", app, listOf(good)))
    assertFalse("no asset links, no passkey", CredentialCore.rpAllowed("harlow.test", app, null))
    assertTrue(CredentialCore.rpAllowed("harlow.test", chrome, null))
  }

  @Test fun clientData() {
    assertEquals(
      "{\"type\":\"webauthn.get\",\"challenge\":\"Y2hhbGxlbmdl\",\"origin\":\"https://portal.harlow.test\",\"crossOrigin\":false}",
      CredentialCore.clientDataJson("webauthn.get", "Y2hhbGxlbmdl", "https://portal.harlow.test"),
    )
    assertEquals(
      "{\"type\":\"webauthn.create\",\"challenge\":\"Y2g\",\"origin\":\"android:apk-key-hash:q6ur\",\"crossOrigin\":false,\"androidPackageName\":\"test.harlow.portal\"}",
      CredentialCore.clientDataJson("webauthn.create", "Y2g", "android:apk-key-hash:q6ur", "test.harlow.portal"),
    )
    val cd = "{}"
    assertArrayEquals(CredentialCore.sha256(cd.toByteArray()), CredentialCore.clientDataHash(null, cd))
    val given = ByteArray(32) { 7 }
    assertArrayEquals(given, CredentialCore.clientDataHash(given, cd))
    assertArrayEquals("a hash of the wrong size is not the platform's", CredentialCore.sha256(cd.toByteArray()), CredentialCore.clientDataHash(ByteArray(5), cd))
  }

  @Test fun escaping() {
    assertEquals("\"a\\\"b\\\\c\\n\\u0001\"", CredentialCore.jsonString("a\"b\\c\n\u0001"))
    assertEquals("\"alex@harlow.test\"", CredentialCore.jsonString("alex@harlow.test"))
  }

  @Test fun assertionShape() {
    assertEquals(
      "{\"id\":\"Y3JlZA\",\"rawId\":\"Y3JlZA\",\"type\":\"public-key\",\"authenticatorAttachment\":\"platform\"," +
        "\"response\":{\"clientDataJSON\":\"e30\",\"authenticatorData\":\"YXV0aA\",\"signature\":\"c2ln\",\"userHandle\":\"dXNlcg\"}," +
        "\"clientExtensionResults\":{}}",
      CredentialCore.assertionJson("Y3JlZA", "e30", "YXV0aA", "c2ln", "dXNlcg"),
    )
    assertFalse(CredentialCore.assertionJson("Y3JlZA", "e30", "YXV0aA", "c2ln", "").contains("userHandle"))
  }

  @Test fun registrationShape() {
    assertEquals(
      "{\"id\":\"Y3JlZA\",\"rawId\":\"Y3JlZA\",\"type\":\"public-key\",\"authenticatorAttachment\":\"platform\"," +
        "\"response\":{\"clientDataJSON\":\"e30\",\"attestationObject\":\"YXR0\",\"authenticatorData\":\"YXV0aA\",\"publicKey\":\"cGs\"," +
        "\"publicKeyAlgorithm\":-7,\"transports\":[\"internal\",\"hybrid\"]}," +
        "\"clientExtensionResults\":{\"credProps\":{\"rk\":true}}}",
      CredentialCore.registrationJson("Y3JlZA", "e30", "YXR0", "YXV0aA", "cGs"),
    )
  }
}
