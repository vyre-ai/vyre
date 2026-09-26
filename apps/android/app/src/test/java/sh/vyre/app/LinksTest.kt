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
        assertEquals("tab/projects", Links.route("vyre://projects"))
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
}
