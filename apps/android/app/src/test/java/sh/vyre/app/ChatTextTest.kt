package sh.vyre.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.vyre.app.api.JsonCodec
import sh.vyre.app.api.flatten
import sh.vyre.app.data.ChatText
import sh.vyre.app.data.Line
import sh.vyre.app.data.ToolCall
import sh.vyre.app.data.Transcript
import java.util.Calendar
import java.util.Locale

class ChatTextTest {
    private fun call(tool: String, summary: String, dest: String? = null, done: Boolean = true) = ToolCall("t", tool, summary, dest, done, false)

    @Test fun toolRowsReadAsWhatWasDone() {
        assertEquals("Ran npm test", ChatText.phrase(call("Bash", "npm test")))
        assertEquals("Running npm test", ChatText.phrase(call("Bash", "npm test", done = false)))
        assertEquals("Edited reports/q3.tsx", ChatText.phrase(call("Edit", "Edit /work/harlow/reports/q3.tsx", "/work/harlow/reports/q3.tsx")))
        assertEquals("Wrote notes.md", ChatText.phrase(call("Write", "Write notes.md", "notes.md")))
        assertEquals("Fetched api.example.com", ChatText.phrase(call("WebFetch", "fetch https://api.example.com/v1/orders", "https://api.example.com/v1/orders")))
        assertEquals("Searched pattern: **/*.ts", ChatText.phrase(call("Glob", "Glob pattern: **/*.ts")))
        assertEquals("Used send invoice", ChatText.phrase(call("mcp__northwind__send_invoice", "mcp__northwind__send_invoice to: kit")))
    }

    @Test fun memoryToolsAreRecalled() {
        assertTrue(ChatText.memory("mcp__vyre__recall_search"))
        assertTrue(ChatText.memory("memory.relevant"))
        assertFalse(ChatText.memory("Bash"))
    }

    @Test fun stampsGoBeforeTheFirstLineAndAfterAnHour() {
        val h = 3_600_000L
        assertEquals(setOf(0, 3), ChatText.stamps(listOf(0L, 60_000L, null, 2 * h, 2 * h + 1)))
        assertEquals(setOf(1), ChatText.stamps(listOf(null, 5L)))
    }

    @Test fun stampsSayTodayYesterdayOrTheDate() {
        val now = Calendar.getInstance().apply { set(2026, Calendar.SEPTEMBER, 27, 12, 30, 0) }.timeInMillis
        val today = Calendar.getInstance().apply { set(2026, Calendar.SEPTEMBER, 27, 12, 1, 0) }.timeInMillis
        val yesterday = Calendar.getInstance().apply { set(2026, Calendar.SEPTEMBER, 26, 9, 12, 0) }.timeInMillis
        val before = Calendar.getInstance().apply { set(2026, Calendar.SEPTEMBER, 25, 14, 3, 0) }.timeInMillis
        assertEquals("Today 12:01", ChatText.stamp(today, now, Locale.US))
        assertEquals("Yesterday 09:12", ChatText.stamp(yesterday, now, Locale.US))
        assertEquals("Sep 25 14:03", ChatText.stamp(before, now, Locale.US))
    }

    @Test fun theHolderLineNamesAnotherSurfaceOnly() {
        assertNull(ChatText.holder(null, "android"))
        assertNull(ChatText.holder("android", "android"))
        assertEquals("The Deck", ChatText.holder("deck", "android"))
        assertEquals("kit", ChatText.holder("agent:kit", "android"))
        assertEquals("Another of your devices", ChatText.holder("tailnet:alex@example.com", "android"))
    }

    @Test fun questionsRaisedInASessionAreQuestionCards() {
        val t = Transcript("t1")
        t.add(flatten(JsonCodec.parseToJsonElement("""{"id":5,"at":10,"type":"ask.raised","payload":{"thread":"t1","ask":"q1","kind":"question","tool":"AskUserQuestion","summary":"Which report?",
            "questions":[{"question":"Which report?","options":[{"label":"Q3"}]}],"agent":"kit"}}""")))
        t.add(flatten(JsonCodec.parseToJsonElement("""{"id":6,"at":20,"type":"ask.answered","payload":{"thread":"t1","ask":"q1","decision":"allow","by":"android"}}""")))
        val a = t.items.single() as Line.Ask
        assertTrue(a.question)
        assertEquals("allow", a.decision)
        assertEquals(20L, a.decidedAt)
        assertEquals(10L, t.at(a.key))
        assertEquals("Always allowed in Harlow Legal, 12:07".substringBefore(","), sh.vyre.app.ui.answeredLine("always", "project", "Harlow Legal", 0).substringBefore(","))
    }
}
