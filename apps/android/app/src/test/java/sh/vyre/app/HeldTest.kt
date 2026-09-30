package sh.vyre.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.vyre.app.api.JsonCodec
import sh.vyre.app.data.Held

class HeldTest {
    private fun j(s: String) = JsonCodec.parseToJsonElement(s)
    private val item = j("""{"id":"a1","kind":"send","via":"gmail","to":["dana@harlowlegal.com"],"summary":"Invoice for March",
        "state":"held","draft":{"subject":"Invoice for March","body":"Hi Dana,\n\nThe March invoice is attached."},"final":null}""")

    @Test fun finalWordsPutTheDestinationFirstThenEveryField() {
        val w = Held.finalWords(item)
        assertEquals(listOf("to", "subject", "body"), w.map { it.key })
        assertEquals("dana@harlowlegal.com", w[0].original)
        assertEquals("Hi Dana,\n\nThe March invoice is attached.", w[2].original)
    }

    @Test fun finalWinsOverDraft() {
        val revised = j(item.toString().replace("\"final\":null", "\"final\":{\"subject\":\"Invoice for March\",\"body\":\"Hi Dana, attached.\"}"))
        assertEquals("Hi Dana, attached.", Held.finalWords(revised).first { it.key == "body" }.original)
    }

    @Test fun reasonNamesWhereAndHowItStarts() {
        val r = Held.reason(item, "Send")
        assertTrue(r, r.startsWith("Send to dana@harlowlegal.com: Invoice for March. Hi Dana, The March"))
        assertTrue(r.length <= 120)
    }

    @Test fun aRevisionChangesWhatWasShown() {
        val revised = j(item.toString().replace("\"final\":null", "\"final\":{\"subject\":\"Invoice for March\",\"body\":\"Pay now.\"}"))
        val readdressed = j(item.toString().replace("dana@harlowlegal.com", "someone@northwind.example"))
        assertEquals(Held.shown(item), Held.shown(j(item.toString())))
        assertNotEquals(Held.shown(item), Held.shown(revised))
        assertNotEquals(Held.shown(item), Held.shown(readdressed))
    }
}
