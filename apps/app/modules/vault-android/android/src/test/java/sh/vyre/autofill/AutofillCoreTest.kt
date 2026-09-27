// Plain JVM tests for AutofillCore: field classification, the origin strings, the device-key
// challenge and the vyred address. No Android classes, no emulator. Sample world only.

package sh.vyre.autofill

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AutofillCoreTest {
  private fun web(vararg attrs: Pair<String, String>, tag: String = "input") = FieldInfo(htmlTag = tag, htmlAttrs = mapOf(*attrs))
  private fun c(f: FieldInfo) = AutofillCore.classify(f)

  // ---- classification ----

  @Test fun autofillHintsComeFirst() {
    assertEquals(Role.USERNAME, c(FieldInfo(hints = listOf("username"), idEntry = "password_box")))
    assertEquals(Role.PASSWORD, c(FieldInfo(hints = listOf("password"))))
    assertEquals(Role.NEW_PASSWORD, c(FieldInfo(hints = listOf("newPassword"))))
    assertEquals(Role.EMAIL, c(FieldInfo(hints = listOf("emailAddress"))))
    assertEquals(Role.OTP, c(FieldInfo(hints = listOf("smsOTPCode"))))
    assertEquals(Role.OTP, c(FieldInfo(hints = listOf("2faAppOTPCode"))))
    assertEquals(Role.CARD_NUMBER, c(FieldInfo(hints = listOf("creditCardNumber"))))
    assertEquals(Role.CARD_EXP_MONTH, c(FieldInfo(hints = listOf("creditCardExpirationMonth"))))
    assertEquals(Role.POSTAL, c(FieldInfo(hints = listOf("postalCode"))))
  }

  @Test fun unknownHintFallsThrough() {
    assertEquals(Role.PASSWORD, c(FieldInfo(hints = listOf("somethingElse"), idEntry = "login_password")))
  }

  @Test fun notFillableIsNothing() {
    assertNull(c(FieldInfo(fillable = false, hints = listOf("password"))))
  }

  @Test fun htmlAutocomplete() {
    assertEquals(Role.USERNAME, c(web("autocomplete" to "username", "name" to "q")))
    assertEquals(Role.PASSWORD, c(web("autocomplete" to "current-password", "type" to "password")))
    assertEquals(Role.NEW_PASSWORD, c(web("autocomplete" to "new-password", "type" to "password")))
    assertEquals(Role.OTP, c(web("autocomplete" to "one-time-code")))
    assertEquals(Role.CARD_CVV, c(web("autocomplete" to "billing cc-csc")))
    assertEquals(Role.REGION, c(web("autocomplete" to "section-ship shipping address-level1")))
    // A token that names something else is not ours, even with a tempting name.
    assertNull(c(web("autocomplete" to "bday", "name" to "password")))
  }

  @Test fun htmlTypes() {
    assertEquals(Role.PASSWORD, c(web("type" to "password", "name" to "pw")))
    assertEquals(Role.NEW_PASSWORD, c(web("type" to "password", "name" to "confirm_password")))
    assertEquals(Role.EMAIL, c(web("type" to "email", "name" to "x")))
    assertNull(c(web("type" to "hidden", "name" to "password")))
    assertNull(c(web("type" to "submit", "name" to "login")))
    assertNull(c(FieldInfo(htmlTag = "button", htmlAttrs = mapOf("name" to "login"))))
  }

  @Test fun inputTypeFlags() {
    val text = AutofillCore.TYPE_CLASS_TEXT
    assertEquals(Role.PASSWORD, c(FieldInfo(inputType = text or AutofillCore.TYPE_TEXT_VARIATION_PASSWORD)))
    assertEquals(Role.PASSWORD, c(FieldInfo(inputType = text or AutofillCore.TYPE_TEXT_VARIATION_WEB_PASSWORD)))
    assertEquals(Role.EMAIL, c(FieldInfo(inputType = text or AutofillCore.TYPE_TEXT_VARIATION_EMAIL_ADDRESS)))
    assertEquals(Role.NEW_PASSWORD, c(FieldInfo(inputType = text or AutofillCore.TYPE_TEXT_VARIATION_PASSWORD, idEntry = "newPassword")))
    val numPw = AutofillCore.TYPE_CLASS_NUMBER or AutofillCore.TYPE_NUMBER_VARIATION_PASSWORD
    assertEquals(Role.OTP, c(FieldInfo(inputType = numPw, hint = "Verification code")))
    assertNull(c(FieldInfo(inputType = numPw, hint = "PIN")))
  }

  @Test fun englishWordsInIdsAndHints() {
    // Harlow Legal's client portal, a native app with resource ids and hints only.
    assertEquals(Role.EMAIL, c(FieldInfo(idEntry = "login_email")))
    assertEquals(Role.USERNAME, c(FieldInfo(idEntry = "userName")))
    assertEquals(Role.PASSWORD, c(FieldInfo(idEntry = "et_password")))
    assertEquals(Role.OTP, c(FieldInfo(hint = "One-time code")))
    assertEquals(Role.USERNAME, c(web("name" to "account_id")))
    // Northwind Bakery's checkout.
    assertEquals(Role.CARD_NUMBER, c(web("name" to "cardNumber")))
    assertEquals(Role.CARD_HOLDER, c(web("placeholder" to "Name on card")))
    assertEquals(Role.CARD_CVV, c(web("name" to "cvc")))
    assertEquals(Role.CARD_EXPIRY, c(web("placeholder" to "MM/YY", "name" to "cc-exp-field")))
    assertEquals(Role.CARD_EXP_MONTH, c(web("name" to "expMonth")))
    assertEquals(Role.CARD_EXP_YEAR, c(web("name" to "exp_year")))
    assertEquals(Role.ADDRESS_LINE1, c(web("name" to "street")))
    assertEquals(Role.ADDRESS_LINE2, c(web("name" to "address2")))
    assertEquals(Role.CITY, c(web("name" to "city")))
    assertEquals(Role.POSTAL, c(web("name" to "zipCode")))
    assertEquals(Role.COUNTRY, c(web("name" to "country", tag = "select")))
    assertEquals(Role.PHONE, c(web("name" to "phone")))
    assertEquals(Role.COMPANY, c(web("name" to "company")))
    assertEquals(Role.NAME, c(web("name" to "full_name")))
  }

  @Test fun securityCodeDependsOnCardWords() {
    assertEquals(Role.CARD_CVV, c(web("name" to "card_security_code")))
    assertEquals(Role.OTP, c(web("placeholder" to "Security code")))
  }

  @Test fun searchAndNoiseAreNotOurs() {
    assertNull(c(web("name" to "search", "placeholder" to "Search Harlow Legal")))
    assertNull(c(web("name" to "promo_code")))
    assertNull(c(FieldInfo(idEntry = "url_bar", hint = "Search or type web address")))
    assertNull(c(FieldInfo(idEntry = "message_body")))
  }

  @Test fun formKinds() {
    val login = AutofillCore.kinds(listOf(Role.EMAIL, Role.PASSWORD))
    assertTrue(login.login); assertFalse(login.address); assertFalse(login.card)
    val emailOnly = AutofillCore.kinds(listOf(Role.EMAIL))
    assertTrue(emailOnly.login)
    val address = AutofillCore.kinds(listOf(Role.NAME, Role.ADDRESS_LINE1, Role.CITY, Role.POSTAL, Role.EMAIL))
    assertTrue(address.address); assertFalse("an email in an address form is the address's", address.login)
    val card = AutofillCore.kinds(listOf(Role.CARD_NUMBER, Role.CARD_CVV))
    assertTrue(card.card); assertFalse(card.login)
    val otp = AutofillCore.kinds(listOf(Role.OTP))
    assertTrue(otp.otp); assertFalse(otp.login)
  }

  @Test fun addressFieldNamesMatchTheVault() {
    assertEquals("line1", AutofillCore.addressField(Role.ADDRESS_LINE1))
    assertEquals("postal", AutofillCore.addressField(Role.POSTAL))
    assertEquals("email", AutofillCore.addressField(Role.EMAIL))
    assertNull(AutofillCore.addressField(Role.PASSWORD))
  }

  @Test fun yearsAndOptions() {
    assertEquals("29", AutofillCore.yearFor("2029", 2))
    assertEquals("2029", AutofillCore.yearFor("2029", 4))
    assertEquals("2029", AutofillCore.yearFor("2029", 0))
    val months = listOf("Month", "01 - January", "02 - February", "07 - July", "12 - December")
    assertEquals(3, AutofillCore.pickOption(months, "07"))
    assertEquals(4, AutofillCore.pickOption(months, "12"))
    assertEquals(2, AutofillCore.pickOption(listOf("--", "2028", "2029"), "2029"))
    assertEquals(2, AutofillCore.pickOption(listOf("--", "28", "29"), "2029"))
    assertEquals(1, AutofillCore.pickOption(listOf("Choose", "United States", "Canada"), "United States"))
    assertEquals(-1, AutofillCore.pickOption(listOf("Choose", "Canada"), "US"))
    assertEquals(-1, AutofillCore.pickOption(months, ""))
  }

  // ---- origins ----

  @Test fun webOrigins() {
    assertEquals("https://portal.harlow.test", AutofillCore.webOrigin("portal.harlow.test", null))
    assertEquals("https://portal.harlow.test", AutofillCore.webOrigin("Portal.Harlow.Test.", "https"))
    assertEquals("http://shop.northwind.test", AutofillCore.webOrigin("shop.northwind.test", "http"))
    assertEquals("https://shop.northwind.test", AutofillCore.webOrigin("shop.northwind.test:443", "https"))
    assertEquals("https://shop.northwind.test:8443", AutofillCore.webOrigin("shop.northwind.test:8443", "https"))
    assertNull(AutofillCore.webOrigin("portal.harlow.test", "javascript"))
    assertNull(AutofillCore.webOrigin("portal.harlow.test/login", null))
    assertNull(AutofillCore.webOrigin("user@portal.harlow.test", null))
    assertNull(AutofillCore.webOrigin("", null))
    assertNull(AutofillCore.webOrigin(null, null))
  }

  @Test fun appOrigins() {
    val digest = "AB".repeat(32)
    assertEquals("android://test.harlow.portal@" + "ab".repeat(32), AutofillCore.appOrigin("test.harlow.portal", digest))
    assertEquals("android://test.harlow.portal@" + "ab".repeat(32), AutofillCore.appOrigin("test.harlow.portal", "AB:".repeat(31) + "AB"))
    assertNull(AutofillCore.appOrigin("test.harlow.portal", null))
    assertNull(AutofillCore.appOrigin("test.harlow.portal", "abc"))
    assertNull(AutofillCore.appOrigin("noDots", digest))
    assertNull(AutofillCore.appOrigin("test.harlow/portal", digest))
    assertTrue(AutofillCore.isWebOrigin("https://portal.harlow.test"))
    assertFalse(AutofillCore.isWebOrigin("android://test.harlow.portal@" + "ab".repeat(32)))
  }

  @Test fun certDigest() {
    // SHA-256 of the empty input, a known vector.
    assertEquals("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", AutofillCore.certSha256(ByteArray(0)))
  }

  // ---- the challenge ----

  @Test fun signsOnlyVyredUnlockMessages() {
    val nonce = "Q2hhbGxlbmdlLWZvci1hbGV4LXBpeGVs"
    assertEquals("vyre:fill-unlock:v1:$nonce", AutofillCore.unlockMessage(nonce))
    assertEquals("vyre:fill-unlock:v1:$nonce", AutofillCore.messageToSign(nonce, "vyre:fill-unlock:v1:$nonce"))
    assertNull(AutofillCore.messageToSign(nonce, "vyre:fill-unlock:v1:other-nonce-000000"))
    assertNull(AutofillCore.messageToSign(nonce, "something else entirely"))
    assertNull(AutofillCore.messageToSign("short", "vyre:fill-unlock:v1:short"))
    assertNull(AutofillCore.messageToSign("has spaces in it here", "vyre:fill-unlock:v1:has spaces in it here"))
    assertNull(AutofillCore.messageToSign(null, null))
  }

  // ---- the vyred address ----

  @Test fun serverAddresses() {
    assertEquals("https://vault.harlow.test", AutofillCore.serverUrl("https://vault.harlow.test/", false))
    assertEquals("https://vault.harlow.test", AutofillCore.serverUrl(" https://Vault.Harlow.Test:443 ", false))
    assertEquals("https://vault.harlow.test:8443/vyre", AutofillCore.serverUrl("https://vault.harlow.test:8443/vyre/", false))
    assertNull(AutofillCore.serverUrl("http://vault.harlow.test", false))
    assertNull(AutofillCore.serverUrl("http://vault.harlow.test", true))
    assertNull(AutofillCore.serverUrl("http://127.0.0.1:7777", false))
    assertEquals("http://127.0.0.1:7777", AutofillCore.serverUrl("http://127.0.0.1:7777", true))
    assertNull(AutofillCore.serverUrl("http://localhost:7777", true))
    assertNull(AutofillCore.serverUrl("https://alex@vault.harlow.test", false))
    assertNull(AutofillCore.serverUrl("https://vault.harlow.test/?x=1", false))
    assertNull(AutofillCore.serverUrl("https://vault.harlow.test/#x", false))
    assertNull(AutofillCore.serverUrl("ftp://vault.harlow.test", false))
    assertNull(AutofillCore.serverUrl("not a url", false))
    assertEquals("https://vault.harlow.test/v1/fill/match", AutofillCore.routeUrl("https://vault.harlow.test", "match"))
  }
}
