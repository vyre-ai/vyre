package sh.vyre.app.presence

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import sh.vyre.app.api.ApiError
import sh.vyre.app.api.b64url
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * The phone's presence key: EC P-256 in Android Keystore, StrongBox when the phone has one, the
 * TEE otherwise. It never leaves the hardware. Every signature needs a fresh BIOMETRIC_STRONG
 * touch (auth per use, through a CryptoObject), and enrolling a new fingerprint kills the key.
 */
class DeviceKey(private val context: Context) {
    private val ks: KeyStore get() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    fun exists(): Boolean = runCatching { ks.containsAlias(ALIAS) }.getOrDefault(false)

    /** base64url SPKI DER of the public key, as presence.enroll takes it. */
    fun publicKey(): String? = runCatching { b64url(ks.getCertificate(ALIAS).publicKey.encoded) }.getOrNull()

    fun id(): String? = runCatching { Proof.keyId(ks.getCertificate(ALIAS).publicKey.encoded) }.getOrNull()

    /** Where the key lives, for Settings. */
    fun hardware(): String = if (prefs().getBoolean("strongbox", false)) "StrongBox" else "Trusted Execution Environment"

    /** Can this phone take a strong fingerprint or face now? Null when yes, else what to tell the person. */
    fun canAuthenticate(): String? = when (BiometricManager.from(context).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)) {
        BiometricManager.BIOMETRIC_SUCCESS -> null
        BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> "Add a fingerprint in the phone's settings first."
        BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE, BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> "This phone has no strong fingerprint or face sensor."
        else -> "Fingerprint is not available right now."
    }

    /** Make a new key, replacing any old one. Needs a screen lock and an enrolled fingerprint. */
    fun create(): String {
        runCatching { ks.deleteEntry(ALIAS) }
        val strong = Build.VERSION.SDK_INT >= 28 && context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)
        try { generate(strong) } catch (e: StrongBoxUnavailableException) { generate(false); prefs().edit().putBoolean("strongbox", false).apply(); return publicKey()!! }
        prefs().edit().putBoolean("strongbox", strong).apply()
        return publicKey()!!
    }

    private fun generate(strongBox: Boolean) {
        val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(true)
            .apply {
                if (Build.VERSION.SDK_INT >= 30) setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
                else @Suppress("DEPRECATION") setUserAuthenticationValidityDurationSeconds(-1)
                if (strongBox) setIsStrongBoxBacked(true)
            }.build()
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply { initialize(spec) }.generateKeyPair()
    }

    fun delete() { runCatching { ks.deleteEntry(ALIAS) }; prefs().edit().clear().apply() }

    /**
     * Sign one call. Shows the system fingerprint sheet with `reason` (the tool's summary) as its
     * subtitle; the signature is made inside the CryptoObject the sheet unlocked.
     */
    suspend fun sign(activity: FragmentActivity, tool: String, input: JsonObject, reason: String): String {
        val keyId = id() ?: throw ApiError.PresenceRequired("This phone has no device key yet", listOf("device"))
        val sig = Signature.getInstance("SHA256withECDSA")
        try {
            sig.initSign(ks.getKey(ALIAS, null) as PrivateKey)
        } catch (e: KeyPermanentlyInvalidatedException) {
            throw ApiError.Other("key_invalidated", "A new fingerprint was added, so this phone's key stopped working. Sign in again.", 0)
        }
        val ts = System.currentTimeMillis()
        val nonce = Proof.nonce()
        val msg = Proof.message(tool, input, ts, nonce)
        val unlocked = withContext(Dispatchers.Main) { prompt(activity, BiometricPrompt.CryptoObject(sig), reason) }
        val s = unlocked.signature ?: throw ApiError.Cancelled()
        s.update(msg)
        return Proof.header(keyId, ts, nonce, s.sign())
    }

    private suspend fun prompt(activity: FragmentActivity, crypto: BiometricPrompt.CryptoObject, reason: String): BiometricPrompt.CryptoObject =
        suspendCancellableCoroutine { cont ->
            val bp = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    val c = result.cryptoObject
                    if (c == null) cont.resumeWithException(ApiError.Cancelled()) else cont.resume(c)
                }
                override fun onAuthenticationError(code: Int, msg: CharSequence) {
                    if (cont.isActive) cont.resumeWithException(if (code == BiometricPrompt.ERROR_USER_CANCELED || code == BiometricPrompt.ERROR_NEGATIVE_BUTTON || code == BiometricPrompt.ERROR_CANCELED) ApiError.Cancelled() else ApiError.Other("biometric", msg.toString(), 0))
                }
            })
            val info = BiometricPrompt.PromptInfo.Builder()
                .setTitle("Confirm it's you")
                .setSubtitle(reason.take(120))
                .setNegativeButtonText("Cancel")
                .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                .setConfirmationRequired(false)
                .build()
            bp.authenticate(info, crypto)
            cont.invokeOnCancellation { runCatching { bp.cancelAuthentication() } }
        }

    private fun prefs() = context.getSharedPreferences("device-key", Context.MODE_PRIVATE)

    companion object { const val ALIAS = "vyre-presence-device" }
}
