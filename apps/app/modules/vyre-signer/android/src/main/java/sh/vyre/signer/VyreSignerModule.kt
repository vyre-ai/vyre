// The person session's keys on Android (ADR 0027 section 3a): EC P-256 in the Android Keystore,
// never exportable, in StrongBox where the phone has one and in the TEE where it does not.
//
//   vyre.person  no user auth; signs every request's x-vyre-proof
//   vyre.human   BIOMETRIC_STRONG, per use; signs HUMAN_ONLY calls through BiometricPrompt with a
//                CryptoObject(Signature), so the private key works only after this finger or face
//
// sign() returns the DER signature (SHA256withECDSA) as base64url; the JS side converts it to
// P1363 (derToP1363 in src/auth/person.ts), which is what the box verifies.

package sh.vyre.signer

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.math.BigInteger
import java.security.InvalidAlgorithmParameterException
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.ProviderException
import java.security.SecureRandom
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import javax.crypto.KeyAgreement
import java.security.spec.ECGenParameterSpec

class EnsureOptions : Record {
  @Field val biometric: Boolean = false
}

class SignOptions : Record {
  @Field val prompt: String? = null
}

private const val STORE = "AndroidKeyStore"
private const val PERSON = "vyre.person"
private const val AGREE = "vyre.agree"

class VyreSignerModule : Module() {
  private val random = SecureRandom()

  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("ERR_NO_CONTEXT", "the app has no context yet", null)

  private fun keyStore(): KeyStore = KeyStore.getInstance(STORE).apply { load(null) }

  private fun b64url(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)

  /** A coordinate as exactly 32 unsigned big-endian bytes. */
  private fun fixed32(n: BigInteger): ByteArray {
    val raw = n.toByteArray()
    val out = ByteArray(32)
    val src = if (raw.size > 32) raw.copyOfRange(raw.size - 32, raw.size) else raw
    System.arraycopy(src, 0, out, 32 - src.size, src.size)
    return out
  }

  /** The agreement key: PURPOSE_AGREE_KEY, no user authentication, in StrongBox when asked and the phone has one, else the TEE. */
  private fun makeAgreeKey(strongBox: Boolean) {
    fun spec(sb: Boolean): KeyGenParameterSpec {
      val b = KeyGenParameterSpec.Builder(AGREE, KeyProperties.PURPOSE_AGREE_KEY).setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
      if (sb && Build.VERSION.SDK_INT >= 28) b.setIsStrongBoxBacked(true)
      return b.build()
    }
    val gen = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, STORE)
    try { gen.initialize(spec(strongBox)); gen.generateKeyPair() }
    catch (e: Exception) {
      // a StrongBox that will not make this key: the TEE does
      if (!strongBox) throw CodedException("ERR_KEYGEN", e.message ?: "the agreement key could not be made", e)
      val again = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, STORE)
      again.initialize(spec(false)); again.generateKeyPair()
    }
  }

  private fun strongBoxPresent(): Boolean =
    Build.VERSION.SDK_INT >= 28 && context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)

  private fun spec(alias: String, biometric: Boolean, strongBox: Boolean): KeyGenParameterSpec {
    val b = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
      .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
      .setDigests(KeyProperties.DIGEST_SHA256)
    if (biometric) {
      b.setUserAuthenticationRequired(true)
      if (Build.VERSION.SDK_INT >= 30) {
        // 0 seconds: every signature needs its own biometric.
        b.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
      } else {
        @Suppress("DEPRECATION")
        b.setUserAuthenticationValidityDurationSeconds(-1)
      }
      b.setInvalidatedByBiometricEnrollment(true)
    }
    if (strongBox && Build.VERSION.SDK_INT >= 28) b.setIsStrongBoxBacked(true)
    return b.build()
  }

  private fun generate(alias: String, biometric: Boolean) {
    val gen = { strongBox: Boolean ->
      KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, STORE).run {
        initialize(spec(alias, biometric, strongBox))
        generateKeyPair()
      }
    }
    try {
      if (strongBoxPresent()) {
        try {
          gen(true)
          return
        } catch (e: ProviderException) {
          // StrongBoxUnavailableException (API 28) is a ProviderException; some StrongBox chips
          // refuse a parameter with a plain one. Either way the TEE is the fallback.
          runCatching { keyStore().deleteEntry(alias) }
        }
      }
      gen(false)
    } catch (e: InvalidAlgorithmParameterException) {
      runCatching { keyStore().deleteEntry(alias) }
      if (biometric) throw CodedException("ERR_NO_BIOMETRICS", "a biometric key needs a screen lock and an enrolled fingerprint or face: ${e.message}", e)
      throw CodedException("ERR_KEYGEN", e.message, e)
    }
  }

  private fun coordinates(alias: String): Map<String, String> {
    val pub = keyStore().getCertificate(alias)?.publicKey as? ECPublicKey
      ?: throw CodedException("ERR_NO_KEY", "no key $alias", null)
    return mapOf("x" to b64url(fixed32(pub.w.affineX)), "y" to b64url(fixed32(pub.w.affineY)))
  }

  private fun privateKey(alias: String): PrivateKey =
    keyStore().getKey(alias, null) as? PrivateKey ?: throw CodedException("ERR_NO_KEY", "no key $alias; call ensureKey first", null)

  private fun keyInfo(key: PrivateKey): KeyInfo =
    KeyFactory.getInstance(key.algorithm, STORE).getKeySpec(key, KeyInfo::class.java)

  /** "strongbox", "tee", "software", or "none" when there is no such key. */
  private fun level(alias: String): String {
    val key = runCatching { keyStore().getKey(alias, null) as? PrivateKey }.getOrNull() ?: return "none"
    val info = keyInfo(key)
    if (Build.VERSION.SDK_INT >= 31) {
      return when (info.securityLevel) {
        KeyProperties.SECURITY_LEVEL_STRONGBOX -> "strongbox"
        KeyProperties.SECURITY_LEVEL_SOFTWARE -> "software"
        KeyProperties.SECURITY_LEVEL_UNKNOWN -> "software"
        else -> "tee"
      }
    }
    @Suppress("DEPRECATION")
    return if (info.isInsideSecureHardware) "tee" else "software"
  }

  private fun signNow(sig: Signature, message: ByteArray): String {
    sig.update(message)
    return b64url(sig.sign())
  }

  override fun definition() = ModuleDefinition {
    Name("VyreSigner")

    AsyncFunction("ensureKey") { alias: String, options: EnsureOptions ->
      if (!keyStore().containsAlias(alias)) generate(alias, options.biometric)
      coordinates(alias)
    }

    AsyncFunction("sign") { alias: String, message: String, options: SignOptions, promise: Promise ->
      val key = privateKey(alias)
      val sig = Signature.getInstance("SHA256withECDSA")
      try {
        sig.initSign(key)
      } catch (e: KeyPermanentlyInvalidatedException) {
        throw CodedException("ERR_KEY_INVALIDATED", "the biometrics changed since $alias was made; delete it and sign in again", e)
      }
      val bytes = message.toByteArray(Charsets.UTF_8)
      if (!keyInfo(key).isUserAuthenticationRequired) {
        promise.resolve(signNow(sig, bytes))
        return@AsyncFunction
      }
      val activity = appContext.currentActivity as? FragmentActivity
        ?: throw CodedException("ERR_NO_ACTIVITY", "the biometric prompt needs the app in front", null)
      activity.runOnUiThread {
        val prompt = BiometricPrompt(
          activity,
          ContextCompat.getMainExecutor(activity),
          object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
              val unlocked = result.cryptoObject?.signature
              if (unlocked == null) {
                promise.reject("ERR_BIOMETRIC", "the prompt returned no signature", null)
                return
              }
              try {
                promise.resolve(signNow(unlocked, bytes))
              } catch (e: Exception) {
                promise.reject("ERR_SIGN", e.message, e)
              }
            }

            override fun onAuthenticationError(code: Int, text: CharSequence) {
              val canceled = code == BiometricPrompt.ERROR_USER_CANCELED ||
                code == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
                code == BiometricPrompt.ERROR_CANCELED
              promise.reject(if (canceled) "ERR_CANCELED" else "ERR_BIOMETRIC", text.toString(), null)
            }
            // onAuthenticationFailed: one unrecognised finger; the prompt stays up for another try.
          },
        )
        val info = BiometricPrompt.PromptInfo.Builder()
          .setTitle(options.prompt ?: "Confirm it is you")
          .setNegativeButtonText("Cancel")
          .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
          .build()
        try {
          prompt.authenticate(info, BiometricPrompt.CryptoObject(sig))
        } catch (e: Exception) {
          promise.reject("ERR_BIOMETRIC", e.message, e)
        }
      }
    }

    // The agreement key (ECDH, no prompt per use): an EC P-256 key in the Android Keystore with PURPOSE_AGREE_KEY (Android 12 and later), in StrongBox where the phone has one. No user
    // authentication, so it works while the phone is unlocked. A phone before Android 12 cannot hold such a key: agreePublic then rejects, and the device entry carries no `agree`.
    // agree(epk) is the 32-byte shared secret, the raw X coordinate; HKDF and AES-GCM stay portable code in the app (lib/keywrap.js).
    AsyncFunction("agreePublic") { create: Boolean ->
      if (Build.VERSION.SDK_INT < 31) throw CodedException("ERR_NO_AGREE", "this Android cannot hold an agreement key", null)
      val ks = keyStore()
      if (!ks.containsAlias(AGREE)) {
        if (!create) throw CodedException("ERR_NO_KEY", "there is no agreement key", null)
        makeAgreeKey(strongBox = strongBoxPresent())
      }
      val pub = ks.getCertificate(AGREE).publicKey as ECPublicKey
      val raw = ByteArray(65)
      raw[0] = 4
      System.arraycopy(fixed32(pub.w.affineX), 0, raw, 1, 32)
      System.arraycopy(fixed32(pub.w.affineY), 0, raw, 33, 32)
      b64url(raw)
    }

    AsyncFunction("agree") { epk: String ->
      val point = Base64.decode(epk, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
      if (point.size != 65 || point[0].toInt() != 4) throw CodedException("ERR_INPUT", "that is not a public key", null)
      val ks = keyStore()
      val priv = ks.getKey(AGREE, null) as? PrivateKey ?: throw CodedException("ERR_NO_KEY", "there is no agreement key", null)
      val own = ks.getCertificate(AGREE).publicKey as ECPublicKey
      val peer = try {
        KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(BigInteger(1, point.copyOfRange(1, 33)), BigInteger(1, point.copyOfRange(33, 65))), own.params))
      } catch (e: Exception) { throw CodedException("ERR_INPUT", "that is not a public key", e) }
      val ka = KeyAgreement.getInstance("ECDH")
      ka.init(priv)
      ka.doPhase(peer, true)
      val secret = ka.generateSecret()
      if (secret.size != 32) throw CodedException("ERR_AGREE", "the key gave a bad answer", null)
      b64url(secret)
    }

    AsyncFunction("deleteKey") { alias: String ->
      val ks = keyStore()
      val had = ks.containsAlias(alias)
      if (had) ks.deleteEntry(alias)
      had
    }

    Function("info") {
      val lvl = level(PERSON)
      val secure = when (lvl) {
        "strongbox", "tee" -> true
        "software" -> false
        else -> Build.VERSION.SDK_INT >= 31 && context.packageManager.hasSystemFeature(PackageManager.FEATURE_HARDWARE_KEYSTORE)
      }
      mapOf("strongBox" to strongBoxPresent(), "secureHardware" to secure, "level" to lvl)
    }

    Function("randomBytes") { n: Int ->
      require(n in 1..1024) { "randomBytes takes 1 to 1024" }
      val b = ByteArray(n)
      random.nextBytes(b)
      b64url(b)
    }
  }
}
