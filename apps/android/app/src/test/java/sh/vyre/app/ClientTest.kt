package sh.vyre.app

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonNull
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import sh.vyre.app.api.ApiError
import sh.vyre.app.api.Canonical
import sh.vyre.app.api.Client
import sh.vyre.app.api.JsonCodec
import sh.vyre.app.api.flatten
import sh.vyre.app.api.input
import sh.vyre.app.api.str

class ClientTest {
    private inline fun <reified T : ApiError> err(status: Int, body: String): T = try {
        Client.decode(status, body); fail("no error"); throw IllegalStateException()
    } catch (e: ApiError) { assertTrue("${e::class.simpleName}", e is T); e as T }

    @Test fun dataComesOutOfTheEnvelope() {
        assertEquals("1.2.0", Client.decode(200, """{"data":{"version":"1.2.0"}}""").str("version"))
        assertEquals(JsonNull, Client.decode(200, """{"data":null}"""))
    }

    @Test fun errorsAreTyped() {
        val p = err<ApiError.PresenceRequired>(403, """{"error":{"code":"presence_required","message":"prove it","methods":["device","passkey"]}}""")
        assertEquals(listOf("device", "passkey"), p.methods)
        assertEquals("prove it", p.message)
        err<ApiError.Denied>(403, """{"error":{"code":"denied","message":"gate.get is not available to tailnet:alex callers"}}""")
        err<ApiError.NotOwner>(403, """{"error":{"code":"not_owner","message":"This Vyre serves only its owner."}}""")
        err<ApiError.Misdirected>(421, """{"error":{"code":"misdirected","message":"wrong host"}}""")
        err<ApiError.NoSuchTool>(404, """{"error":{"code":"no_such_tool","message":"no push.subscribe"}}""")
        err<ApiError.BadInput>(400, """{"error":{"code":"bad_input","message":"text is required"}}""")
        val o = err<ApiError.Other>(500, """{"error":{"code":"failed","message":"boom"}}""")
        assertEquals(500, o.status)
        err<ApiError.Other>(502, "Bad gateway")
    }

    @Test fun postsCanonicalJsonWithNoOriginAndReportsOffline() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("""{"data":{"sent":true}}"""))
        server.start()
        val c = Client({ server.url("/").toString() })
        val out = c.call("threads.send", input("thread" to "t1", "text" to "hi", "surface" to "android"), presence = "device key=k ts=1 nonce=nnnnnnnn sig=s")
        assertEquals("true", out.str("sent"))
        val req = server.takeRequest()
        assertEquals("/v1/tools/threads.send", req.path)
        assertEquals("""{"surface":"android","text":"hi","thread":"t1"}""", req.body.readUtf8())
        assertTrue(req.getHeader("content-type")!!.startsWith("application/json"))
        assertNull(req.getHeader("origin"))
        assertNull(req.getHeader("x-vyre-caller"))
        assertEquals("device key=k ts=1 nonce=nnnnnnnn sig=s", req.getHeader("x-vyre-presence"))
        server.shutdown()
        try { c.call("agents.list"); fail("reached a stopped server") } catch (e: ApiError.Offline) { assertTrue(c.offline.value) }
    }

    @Test fun historyEventsFlattenLikeLiveOnes() {
        val hist = flatten(JsonCodec.parseToJsonElement("""{"id":41,"at":5,"type":"thread.tool","payload":{"thread":"t1","id":"toolu_1","tool":"Bash","phase":"started","summary":"npm test"}}"""))
        assertEquals("toolu_1", hist.str("id")); assertEquals("41", hist.str("event")); assertEquals("npm test", hist.str("summary")); assertEquals("thread.tool", hist.str("type"))
        val live = flatten(JsonCodec.parseToJsonElement("""{"id":42,"at":6,"type":"thread.text","source":"threads","thread":"t1","project":"harlow-legal","payload":{"thread":"t1","message":"m1","delta":"Hel"}}"""))
        assertEquals("m1", live.str("message")); assertEquals("harlow-legal", live.str("project")); assertEquals("42", live.str("event"))
        assertEquals("""{"a":1}""", Canonical.encode(input("a" to 1)))
    }
}
