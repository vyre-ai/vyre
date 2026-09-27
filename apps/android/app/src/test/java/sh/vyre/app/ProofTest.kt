package sh.vyre.app

import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.vyre.app.api.JsonCodec
import sh.vyre.app.api.b64url
import sh.vyre.app.api.long
import sh.vyre.app.api.obj
import sh.vyre.app.api.str
import sh.vyre.app.api.unb64url
import sh.vyre.app.presence.Proof
import sh.vyre.app.presence.SignIn
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.X509EncodedKeySpec

/** The device proof against a vector node made the way the box checks it. */
class ProofTest {
    private val v = JsonCodec.parseToJsonElement(javaClass.classLoader!!.getResource("device-vector.json")!!.readText()).obj
    private val input = JsonCodec.parseToJsonElement(v.str("input")!!) as JsonObject

    @Test fun keyIdIsTheBoxFingerprint() { assertEquals(v.str("id"), Proof.keyId(unb64url(v.str("spki")!!))) }

    @Test fun messageIsByteForByteTheBoxOne() {
        assertEquals(v.str("message"), String(Proof.message(v.str("tool")!!, input, v.long("ts")!!, v.str("nonce")!!)))
    }

    @Test fun nodeSignatureVerifiesWithTheJvmAlgorithm() {
        val pub = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(unb64url(v.str("spki")!!)))
        val s = Signature.getInstance("SHA256withECDSA").apply { initVerify(pub); update(Proof.message(v.str("tool")!!, input, v.long("ts")!!, v.str("nonce")!!)) }
        assertTrue(s.verify(unb64url(v.str("sig")!!)))
    }

    @Test fun jvmSignatureIsDerAndTheHeaderParses() {
        val kp = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val msg = Proof.message("threads.answer", input, 1L, "abcdefgh")
        val der = Signature.getInstance("SHA256withECDSA").apply { initSign(kp.private); update(msg) }.sign()
        assertEquals(0x30, der[0].toInt())
        val h = Proof.header(Proof.keyId(kp.public.encoded), 1790000000000, "abcdefgh", der)
        // The box's parse(): "<method> k=v ...", keys [a-z][a-z0-9_]*, values without whitespace.
        val m = Regex("^device key=([A-Za-z0-9_-]{22}) ts=(\\d{1,16}) nonce=([A-Za-z0-9_-]{8,128}) sig=([A-Za-z0-9_-]+)$").find(h)!!
        assertEquals(b64url(der), m.groupValues[4])
        assertTrue(Proof.nonce().matches(Regex("^[A-Za-z0-9_-]{22}$")))
    }

    @Test fun signInLinkAndReturn() {
        assertEquals("https://alex.vyre.run/onboard/device#k=MFkw_-x&n=Pixel%207&r=vyre", SignIn.url("https://alex.vyre.run/", "MFkw_-x", "Pixel 7"))
        assertEquals("AbC-_1234567890123456789", SignIn.enrolledId("vyre://enrolled?id=AbC-_1234567890123456789"))
        assertEquals(null, SignIn.enrolledId("vyre://enrolled?error=cancelled"))
        assertEquals(null, SignIn.enrolledId("https://enrolled?id=AbC-_1234567890123456789"))
    }
}
