package sh.vyre.app

import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import sh.vyre.app.api.ApiError
import sh.vyre.app.api.Client
import sh.vyre.app.api.Prover
import sh.vyre.app.api.input
import sh.vyre.app.api.str

/**
 * The no-nag rule in Client.callOrProve: the fingerprint only when the box asks, once, and one
 * proof opens a presence session that later calls ride. A fake box: each tool answers by the
 * presence header it gets, as core/presence does.
 */
class PresenceTest {
    private lateinit var server: MockWebServer
    private lateinit var client: Client
    private val seen = mutableListOf<Pair<String, String?>>()
    private var signed = mutableListOf<String>()
    /** Which tools this fake box demands a person for, and which it lets a session prove. */
    private var human = setOf("gate.approve", "threads.answer")
    private var sessionable = setOf("gate.approve", "threads.answer")

    private fun refuse(msg: String) = MockResponse().setResponseCode(403).setBody("""{"error":{"code":"presence_required","message":"$msg","methods":["device"]}}""")
    private fun ok(data: String) = MockResponse().setBody("""{"data":$data}""")

    @Before fun start() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val tool = request.path!!.removePrefix("/v1/tools/")
                val h = request.getHeader("x-vyre-presence")
                synchronized(seen) { seen += tool to h }
                if (tool == "presence.session.open") return if (h?.startsWith("device ") == true) ok("""{"session":"s1","secret":"k1","expires":${System.currentTimeMillis() + 1_800_000},"idle":300000}""") else refuse("presence.session.open needs a person")
                if (tool !in human) return ok("""{"tool":"$tool"}""")
                return when {
                    h == null -> refuse("$tool needs a person to prove they are here")
                    h.startsWith("session ") -> when {
                        tool !in sessionable -> refuse("$tool needs its own proof, not a session")
                        h != "session id=s1 secret=k1" -> refuse("no such session, or it ended")
                        else -> ok("""{"tool":"$tool","by":"session"}""")
                    }
                    h.startsWith("device ") -> ok("""{"tool":"$tool","by":"device"}""")
                    else -> refuse("unknown presence method")
                }
            }
        }
        server.start()
        client = Client({ server.url("/").toString() })
        client.prover = Prover { tool, _, _ -> signed += tool; "device key=k1 ts=1 nonce=n0nce1234 sig=$tool" }
    }

    @After fun stop() { server.shutdown() }

    @Test fun aCallTheBoxTakesPlainlyNeverShowsTheSheet() = runBlocking {
        val out = client.callOrProve("agents.list", input(), "List", session = true)
        assertEquals("agents.list", out.str("tool"))
        assertEquals(emptyList<String>(), signed)
        assertEquals(listOf("agents.list" to null), seen)
    }

    @Test fun oneProofOpensASessionThatLaterCallsRide() = runBlocking {
        val first = client.callOrProve("threads.answer", input("ask" to "a1", "decision" to "allow"), "Approve: npm test", session = true)
        assertEquals("session", first.str("by"))
        assertEquals(listOf("presence.session.open"), signed)
        assertEquals(listOf("threads.answer", "presence.session.open", "threads.answer"), seen.map { it.first })
        assertEquals("session id=s1 secret=k1", seen.last().second)
        seen.clear()
        // Within the half hour: no sheet, the session header first.
        val second = client.callOrProve("gate.approve", input("id" to "h1"), "Send to dana", session = true)
        assertEquals("session", second.str("by"))
        assertEquals(1, signed.size)
        assertEquals(listOf("gate.approve" to "session id=s1 secret=k1"), seen)
    }

    @Test fun aBoxThatTakesNoSessionForAToolGetsItsOwnProofAndIsRemembered() = runBlocking {
        sessionable = emptySet()
        val first = client.callOrProve("gate.approve", input("id" to "h1"), "Send to dana", session = true)
        assertEquals("device", first.str("by"))
        assertEquals(listOf("presence.session.open", "gate.approve"), signed)
        seen.clear(); signed.clear()
        // Remembered: the session is not tried for it again, one sheet per send.
        val second = client.callOrProve("gate.approve", input("id" to "h2"), "Send to dana", session = true)
        assertEquals("device", second.str("by"))
        assertEquals(listOf("gate.approve"), signed)
        assertEquals(listOf("gate.approve" to null, "gate.approve" to "device key=k1 ts=1 nonce=n0nce1234 sig=gate.approve"), seen)
    }

    @Test fun requiredSkipsThePlainCall() = runBlocking {
        client.callOrProve("gate.approve", input("id" to "h1"), "Send", required = true, session = false)
        assertEquals(listOf("gate.approve"), signed)
        assertEquals(1, seen.size)
        assertNotNull(seen.single().second)
    }

    @Test fun noPromptMeansNoSheet() = runBlocking {
        try { client.callOrProve("gate.approve", input("id" to "h1"), "Send", session = true, prompt = false); fail("no error") }
        catch (e: ApiError.PresenceRequired) { }
        assertEquals(emptyList<String>(), signed)
        assertEquals(listOf("gate.approve" to null), seen)
    }

    @Test fun theCheckRunsBeforeAProvedAttemptAndCanStopIt() = runBlocking {
        var checks = 0
        try {
            client.callOrProve("gate.approve", input("id" to "h1"), "Send", session = true, check = { checks++; throw IllegalStateException("changed") })
            fail("sent after a change")
        } catch (e: IllegalStateException) { }
        assertEquals(1, checks)
        // The session opened, but the send never went with a proof.
        assertTrue(seen.none { it.first == "gate.approve" && it.second != null })
    }

    @Test fun anEndedSessionIsDroppedAndOneProofOpensANewOne() = runBlocking {
        client.callOrProve("threads.answer", input("ask" to "a1", "decision" to "allow"), "Approve", session = true)
        client.presenceSession = client.presenceSession!!.copy(id = "gone")
        seen.clear()
        val out = client.callOrProve("threads.answer", input("ask" to "a2", "decision" to "deny"), "Deny", session = true)
        assertEquals("session", out.str("by"))
        assertEquals(listOf("presence.session.open", "presence.session.open"), signed)
        assertEquals(listOf("threads.answer", "presence.session.open", "threads.answer"), seen.map { it.first })
        assertEquals("s1", client.presenceSession?.id)
    }

    @Test fun withoutSessionTheProofSignsTheCallRetriedOnce() = runBlocking {
        val out = client.callOrProve("gate.approve", input("id" to "h1"), "Send")
        assertEquals("device", out.str("by"))
        assertEquals(listOf("gate.approve"), signed)
        assertNull(client.presenceSession)
    }
}
