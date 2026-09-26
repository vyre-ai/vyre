package sh.vyre.app.push

import kotlinx.serialization.json.JsonObject
import sh.vyre.app.api.JsonCodec
import sh.vyre.app.api.obj
import sh.vyre.app.api.str
import sh.vyre.app.api.unb64url
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** What a push opens to: the path holds only an id (ADR 0011 point 2). */
data class Sealed(val path: String, val tag: String?, val at: Long?)

/**
 * The part of a push only this phone can read: AES-256-GCM under the 32-byte key the app gave
 * push.subscribe. Wire form: base64url(iv 12 bytes || ciphertext || tag 16 bytes), plaintext
 * JSON {path, tag, at}. Pure, so it is tested on the JVM.
 */
object Seal {
    fun open(key: ByteArray, sealed: String): Sealed? = runCatching {
        require(key.size == 32)
        val raw = unb64url(sealed)
        require(raw.size > 12 + 16)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, raw, 0, 12))
        val plain = c.doFinal(raw, 12, raw.size - 12)
        val o: JsonObject = JsonCodec.parseToJsonElement(String(plain, Charsets.UTF_8)).obj
        val path = o.str("path") ?: return null
        // Only the two paths the box sends; anything else is dropped, not opened.
        if (!Regex("^/(needs|threads)/[A-Za-z0-9_-]{1,128}$").matches(path) && !path.startsWith("/settings")) return null
        Sealed(path, o.str("tag"), o.str("at")?.toLongOrNull())
    }.getOrNull()

    /** The other direction, for tests and for a fake FCM in the test world. */
    fun seal(key: ByteArray, json: String, iv: ByteArray): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
        return sh.vyre.app.api.b64url(iv + c.doFinal(json.toByteArray(Charsets.UTF_8)))
    }
}
