package sh.vyre.app.push

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import sh.vyre.app.api.b64url
import sh.vyre.app.api.unb64url
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The 32 random bytes the box seals push paths to. Kept in app-private prefs, wrapped by a
 * Keystore AES key (no fingerprint: a notification must open without one).
 */
object PushKey {
    private const val WRAP = "vyre-push-wrap"

    fun get(context: Context): ByteArray? = runCatching {
        val p = prefs(context)
        val iv = p.getString("iv", null) ?: return null
        val ct = p.getString("ct", null) ?: return null
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, wrapKey(), GCMParameterSpec(128, unb64url(iv)))
        c.doFinal(unb64url(ct))
    }.getOrNull()

    /** A fresh key, stored, returned as base64url for push.subscribe. */
    fun create(context: Context): String {
        val raw = ByteArray(32).also(SecureRandom()::nextBytes)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, wrapKey())
        prefs(context).edit().putString("iv", b64url(c.iv)).putString("ct", b64url(c.doFinal(raw))).apply()
        return b64url(raw)
    }

    fun wipe(context: Context) {
        prefs(context).edit().clear().apply()
        runCatching { KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(WRAP) }
    }

    private fun wrapKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(WRAP, null) as? SecretKey)?.let { return it }
        val g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        g.init(KeyGenParameterSpec.Builder(WRAP, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
        return g.generateKey()
    }

    private fun prefs(context: Context) = context.getSharedPreferences("push-key", Context.MODE_PRIVATE)
}
