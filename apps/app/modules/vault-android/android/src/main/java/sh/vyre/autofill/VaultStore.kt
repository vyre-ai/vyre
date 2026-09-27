// Where the phone keeps what pairing gave it, and the device key.
//
//   - The server address, device id, device name and device token live in
//     EncryptedSharedPreferences (AES-256-GCM values under an Android Keystore master key). The
//     token alone reveals no value: it lists names and asks for challenges (core/vault/fill.js).
//   - The fill window's session token lives in memory only. The service and the auth activity run
//     in the app's process, so they share it; when the process dies the next fill asks for the
//     finger again, which is the safe way to fail.
//   - A login waiting to be saved while the person unlocks is held in memory under a random id,
//     for two minutes at most. Only the id travels in the Intent.
//   - The device key is EC P-256 in the Android Keystore, StrongBox where the phone has one,
//     BIOMETRIC_STRONG for every use (0 seconds), so a signature is a person's presence. Made the
//     way modules/vyre-signer makes vyre.human.

package sh.vyre.autofill

import android.content.Context
import android.content.SharedPreferences
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.security.InvalidAlgorithmParameterException
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.ProviderException
import java.security.SecureRandom
import java.security.Signature
import java.util.concurrent.ConcurrentHashMap

data class Paired(val server: String, val token: String, val device: String, val name: String)

object VaultStore {
  private const val PREFS = "sh.vyre.autofill.store"
  private const val K_SERVER = "server"
  private const val K_TOKEN = "token"
  private const val K_DEVICE = "device"
  private const val K_NAME = "name"

  @Volatile private var prefs: SharedPreferences? = null

  private fun prefs(context: Context): SharedPreferences = prefs ?: synchronized(this) {
    prefs ?: run {
      val app = context.applicationContext
      val master = MasterKey.Builder(app).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
      EncryptedSharedPreferences.create(
        app, PREFS, master,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
      ).also { prefs = it }
    }
  }

  fun isDebug(context: Context) = (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

  /** The server as set, whether or not the phone is paired yet. */
  fun server(context: Context): String? = prefs(context).getString(K_SERVER, null)

  fun setServer(context: Context, url: String) { prefs(context).edit().putString(K_SERVER, url).apply() }

  fun paired(context: Context): Paired? {
    val p = prefs(context)
    val server = p.getString(K_SERVER, null) ?: return null
    val token = p.getString(K_TOKEN, null) ?: return null
    return Paired(server, token, p.getString(K_DEVICE, "") ?: "", p.getString(K_NAME, "") ?: "")
  }

  fun savePairing(context: Context, server: String, token: String, device: String, name: String) {
    prefs(context).edit()
      .putString(K_SERVER, server).putString(K_TOKEN, token)
      .putString(K_DEVICE, device).putString(K_NAME, name)
      .commit()
  }

  fun clear(context: Context) {
    prefs(context).edit().remove(K_TOKEN).remove(K_DEVICE).remove(K_NAME).commit()
    Session.clear()
    PendingSaves.clear()
    DeviceKey.delete()
  }

  fun client(context: Context): FillClient? = paired(context)?.let { FillClient(it.server, it.token) }
}

/** The fill window: vyred's session token and when it ends. Memory only. */
object Session {
  private data class Open(val token: String, val expires: Long, val opened: Long)
  @Volatile private var open: Open? = null

  fun token(now: Long = System.currentTimeMillis()): String? = open?.takeIf { it.expires - 5_000 > now }?.token

  /** When the proof behind this window was made; a card asks for a fresh one. */
  fun openedAt(): Long = open?.opened ?: 0L

  fun set(token: String, expires: Long) { open = Open(token, expires, System.currentTimeMillis()) }

  fun clear() { open = null }
}

/** A login the person asked to save, waiting for the unlock. Values stay in this process. */
object PendingSaves {
  data class Save(val url: String, val username: String, val password: String, val at: Long)

  private const val TTL_MS = 120_000L
  private val random = SecureRandom()
  private val held = ConcurrentHashMap<String, Save>()

  fun put(url: String, username: String, password: String): String {
    sweep()
    val b = ByteArray(18).also { random.nextBytes(it) }
    val id = Base64.encodeToString(b, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    held[id] = Save(url, username, password, System.currentTimeMillis())
    return id
  }

  /** Take (and forget) a held save. */
  fun take(id: String?): Save? {
    sweep()
    return id?.let { held.remove(it) }
  }

  fun clear() = held.clear()

  private fun sweep() {
    val t = System.currentTimeMillis()
    held.entries.removeIf { t - it.value.at > TTL_MS }
  }
}

/** Error codes the JS side sees, as vyre-signer names them. */
class VyreException(val code: String, message: String) : Exception(message)

object DeviceKey {
  const val ALIAS = "vyre.fill.device"
  private const val STORE = "AndroidKeyStore"

  private fun keyStore(): KeyStore = KeyStore.getInstance(STORE).apply { load(null) }

  fun exists(): Boolean = runCatching { keyStore().containsAlias(ALIAS) }.getOrDefault(false)

  fun delete() { runCatching { keyStore().deleteEntry(ALIAS) } }

  private fun strongBoxPresent(context: Context): Boolean =
    Build.VERSION.SDK_INT >= 28 && context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)

  private fun spec(strongBox: Boolean): KeyGenParameterSpec {
    val b = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
      .setAlgorithmParameterSpec(java.security.spec.ECGenParameterSpec("secp256r1"))
      .setDigests(KeyProperties.DIGEST_SHA256)
      .setUserAuthenticationRequired(true)
      .setInvalidatedByBiometricEnrollment(true)
    if (Build.VERSION.SDK_INT >= 30) {
      // 0 seconds: every signature needs its own strong biometric.
      b.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
    } else {
      @Suppress("DEPRECATION")
      b.setUserAuthenticationValidityDurationSeconds(-1)
    }
    if (strongBox && Build.VERSION.SDK_INT >= 28) b.setIsStrongBoxBacked(true)
    return b.build()
  }

  /**
   * A new device key (any old one is deleted first). Returns its public key as SPKI DER,
   * base64url: what vyred's pair route takes as `key`.
   */
  fun create(context: Context): String {
    delete()
    val gen = { strongBox: Boolean ->
      KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, STORE).run {
        initialize(spec(strongBox))
        generateKeyPair()
      }
    }
    val pair = try {
      if (strongBoxPresent(context)) {
        try { gen(true) } catch (e: ProviderException) {
          // StrongBoxUnavailableException is a ProviderException; the TEE is the fallback.
          delete()
          gen(false)
        }
      } else gen(false)
    } catch (e: InvalidAlgorithmParameterException) {
      delete()
      throw VyreException("ERR_NO_BIOMETRICS", "the device key needs a screen lock and an enrolled fingerprint or face")
    } catch (e: Exception) {
      delete()
      throw VyreException("ERR_KEYGEN", e.message ?: "the keystore refused")
    }
    // X.509 SubjectPublicKeyInfo DER: what core/vault/fill.js deviceKey() parses.
    return Base64.encodeToString(pair.public.encoded, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
  }

  /** A Signature ready for BiometricPrompt's CryptoObject. */
  fun signature(): Signature {
    val key = keyStore().getKey(ALIAS, null) as? PrivateKey
      ?: throw VyreException("ERR_NO_KEY", "this phone has no Vyre device key; pair it again")
    val sig = Signature.getInstance("SHA256withECDSA")
    try {
      sig.initSign(key)
    } catch (e: KeyPermanentlyInvalidatedException) {
      throw VyreException("ERR_KEY_INVALIDATED", "the fingerprints or face changed since pairing; pair this phone again")
    }
    return sig
  }

  /** "strongbox", "tee", "software", or "none". */
  fun level(): String {
    val key = runCatching { keyStore().getKey(ALIAS, null) as? PrivateKey }.getOrNull() ?: return "none"
    val info = runCatching { KeyFactory.getInstance(key.algorithm, STORE).getKeySpec(key, KeyInfo::class.java) }.getOrNull() ?: return "none"
    if (Build.VERSION.SDK_INT >= 31) {
      return when (info.securityLevel) {
        KeyProperties.SECURITY_LEVEL_STRONGBOX -> "strongbox"
        KeyProperties.SECURITY_LEVEL_SOFTWARE, KeyProperties.SECURITY_LEVEL_UNKNOWN -> "software"
        else -> "tee"
      }
    }
    @Suppress("DEPRECATION")
    return if (info.isInsideSecureHardware) "tee" else "software"
  }

  fun b64url(bytes: ByteArray): String = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
}
