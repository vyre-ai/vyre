package sh.vyre.app.presence

import kotlinx.serialization.json.JsonObject
import sh.vyre.app.api.Canonical
import sh.vyre.app.api.b64url
import java.security.MessageDigest
import java.security.SecureRandom

/** The pure half of a device proof, tested on the JVM: what is signed and how the header reads. */
object Proof {
    /** `vyre-presence-v1\n<tool>\n<input hash>\n<ts>\n<nonce>`, the Capsule's message (ADR 0018 section 3). */
    fun message(tool: String, input: JsonObject, ts: Long, nonce: String): ByteArray =
        "vyre-presence-v1\n$tool\n${Canonical.hash(input)}\n$ts\n$nonce".toByteArray(Charsets.UTF_8)

    /** `device key=<id> ts=<ms> nonce=<n> sig=<DER ECDSA, base64url>`. */
    fun header(keyId: String, ts: Long, nonce: String, derSig: ByteArray): String = "device key=$keyId ts=$ts nonce=$nonce sig=${b64url(derSig)}"

    /** The key id the box derives: the first 22 characters of base64url(sha256(SPKI DER)). */
    fun keyId(spkiDer: ByteArray): String = b64url(MessageDigest.getInstance("SHA-256").digest(spkiDer)).take(22)

    /** 16 random bytes, base64url: 22 characters from [A-Za-z0-9_-], inside the box's 8..128 rule. */
    fun nonce(rnd: SecureRandom = SecureRandom()): String = ByteArray(16).also(rnd::nextBytes).let(::b64url)
}
