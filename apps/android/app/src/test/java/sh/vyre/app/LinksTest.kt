package sh.vyre.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import sh.vyre.app.data.Links

class LinksTest {
    @Test fun pushPaths() {
        assertEquals("needs/abc123", Links.route("/needs/abc123"))
        assertEquals("thread/0f1e-22", Links.route("/threads/0f1e-22"))
        assertEquals("settings", Links.route("/settings?section=lessons"))
    }

    @Test fun vyreLinks() {
        assertEquals("needs/abc", Links.route("vyre://needs/abc"))
        assertEquals("thread/t1", Links.route("vyre://threads/t1/"))
        assertEquals("tab/find", Links.route("vyre://find"))
        assertEquals("tab/find", Links.route("vyre://capsule"))
        assertEquals("tab/chats", Links.route("vyre://chats"))
        assertEquals("tab/chats", Links.route("vyre://projects"))
        assertEquals("tab/agents", Links.route("vyre://agents"))
        assertEquals("tab/now", Links.route("vyre://more"))
        assertNull(Links.route("vyre://enrolled?id=abcdefgh"))
    }

    @Test fun refusesOthers() {
        assertNull(Links.route("https://evil.example/needs/x"))
        assertNull(Links.route("/needs/../../etc"))
        assertNull(Links.route("/needs/a b"))
        assertNull(Links.route(null))
    }

    @Test fun addresses() {
        assertEquals("https://vyre.example.ts.net", Links.address("vyre.example.ts.net"))
        assertEquals("https://vyre.example.ts.net", Links.address(" https://Vyre.example.ts.net/ "))
        assertEquals("http://10.0.2.2:4801", Links.address("http://10.0.2.2:4801"))
        assertEquals("https://vyre.example.ts.net:8443", Links.address("vyre.example.ts.net:8443/deck"))
        assertNull(Links.address("not an address"))
        assertNull(Links.address("vyre"))
        assertNull(Links.address(""))
    }

    @Test fun sessionsOpenOnChatFromEveryDoor() {
        // A push path, a vyre:// link and an in-app "Open session" all land on the same route and tab.
        val id = "3f2a9c1e-5b7d-4e21-9a0c-1d2e3f4a5b6c"
        val fromPush = Links.route("/threads/$id")
        val fromLink = Links.route("vyre://threads/$id")
        val inApp = Links.session(id)
        assertEquals("thread/$id", fromPush)
        assertEquals(fromPush, fromLink)
        assertEquals(fromPush, inApp)
        assertEquals("chats", Links.tabOf(fromPush!!))
        assertEquals("now", Links.tabOf(Links.route("/needs/abc")!!))
        assertEquals("now", Links.tabOf("settings"))
        assertEquals("find", Links.tabOf("tab/find"))
        assertNull(Links.session("../x"))
        assertNull(Links.session(null))
    }
}
