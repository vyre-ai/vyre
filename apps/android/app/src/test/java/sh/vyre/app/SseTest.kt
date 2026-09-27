package sh.vyre.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.vyre.app.api.Backoff
import sh.vyre.app.api.SseFrame
import sh.vyre.app.api.SseParser

class SseTest {
    private fun all(text: String): List<SseFrame> = SseParser().feed(text)

    @Test fun readsTheBoxFrames() {
        val f = all("id: 7\nevent: thread.text\ndata: {\"id\":7}\n\n: beat\n\nid: 8\nevent: gate.held\ndata: {\"id\":8}\n\n")
        assertEquals(listOf(SseFrame("7", "thread.text", "{\"id\":7}"), SseFrame("8", "gate.held", "{\"id\":8}")), f)
    }

    @Test fun commentsAloneDispatchNothing() { assertTrue(all(": beat\n\n: beat\n\n").isEmpty()) }

    @Test fun joinsMultiLineData() {
        assertEquals("a\nb\n", all("data: a\ndata:b\ndata\n\n").single().data)
    }

    @Test fun onlyOneLeadingSpaceIsTrimmed() { assertEquals("  x", all("data:   x\n\n").single().data) }

    @Test fun crlfAndCrEndLines() {
        val f = all("id: 1\r\ndata: x\r\n\r\nid: 2\rdata: y\r\r")
        assertEquals(listOf("1", "2"), f.map { it.id }); assertEquals(listOf("x", "y"), f.map { it.data })
    }

    @Test fun chunksSplitAnywhere() {
        val p = SseParser()
        val text = "id: 10\r\nevent: ask.raised\r\ndata: {\"a\":1}\r\n\r\n"
        val out = text.chunked(3).flatMap(p::feed)
        assertEquals(listOf(SseFrame("10", "ask.raised", "{\"a\":1}")), out)
        assertEquals("10", p.lastId)
    }

    @Test fun idCarriesOverAndUnknownFieldsAreIgnored() {
        val p = SseParser()
        val f = p.feed("id: 5\ndata: a\n\nretry: 100\nfoo: bar\ndata: b\n\n")
        assertEquals(listOf("5", "5"), f.map { it.id })
    }

    @Test fun backoffDoublesToThirtySeconds() {
        val b = Backoff(jitter = { 0.0 })
        assertEquals(listOf(1000L, 2000, 4000, 8000, 16000, 30000, 30000), List(7) { b.next() })
        b.reset(); assertEquals(1000L, b.next())
    }
}
