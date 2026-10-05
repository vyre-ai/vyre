package sh.vyre.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.vyre.app.api.Canonical
import sh.vyre.app.api.JsonCodec
import sh.vyre.app.api.flatten
import sh.vyre.app.data.Anchor
import sh.vyre.app.data.AskView
import sh.vyre.app.data.Gate
import sh.vyre.app.data.Need
import sh.vyre.app.data.Needs
import sh.vyre.app.data.Pick
import sh.vyre.app.data.Questions
import sh.vyre.app.data.Transcript
import sh.vyre.app.data.answerInput
import sh.vyre.app.data.heldFor

class AsksTest {
    private fun j(s: String) = JsonCodec.parseToJsonElement(s)
    private val now = 1_800_000_000_000L

    private val question = j("""{"id":"q1","kind":"question","thread":"t1","agent":"kit","thread_name":"q3 report","at":${now - 60_000},
        "questions":[{"question":"Which report?","header":"Report","multiSelect":false,"options":[{"label":"Q3","description":"The short one"},{"label":"Q4"}]},
                     {"question":"Who gets it?","multiSelect":true,"options":[{"label":"Dana"},{"label":"Northwind Bakery"},{"label":"alex"}]}]}""")

    @Test fun questionsAreNeedsRowsWithTheirAgent() {
        val n = Needs.rows(emptyList(), listOf(question), { null }, { "harlow-legal" }).single()
        assertEquals(Need.Kind.Question, n.kind)
        assertEquals("kit has a question", n.title)
        assertEquals("Which report?", n.line)
        assertEquals("Later", n.no)
        assertEquals("kit, harlow-legal, asks: Which report?, 1 minute ago.", Needs.label(n, now))
    }

    @Test fun answersFollowTheDecksRules() {
        val qs = Questions.of(question)
        assertEquals(2, qs.size)
        var a = Pick(); var b = Pick()
        assertNull(Questions.answers(qs, listOf(a, b)))
        a = Questions.choose(qs[0], a, "Q4"); a = Questions.choose(qs[0], a, "Q3")
        b = Questions.choose(qs[1], b, "alex"); b = Questions.choose(qs[1], b, "Dana")
        b = Questions.choose(qs[1], b, null).copy(text = " the board ")
        assertEquals(mapOf("Which report?" to "Q3", "Who gets it?" to "Dana, alex, the board"), Questions.answers(qs, listOf(a, b)))
        // Single-select "Something else" replaces the choice with the typed text.
        val typed = Questions.choose(qs[0], a, null).copy(text = "Q2")
        assertEquals("Q2", Questions.text(qs[0], typed))
        assertFalse(Questions.answered(qs[0], Questions.choose(qs[0], a, null)))
    }

    @Test fun theAnswerInputIsWhatThreadsAnswerTakes() {
        assertEquals("""{"answers":{"Which report?":"Q3"},"ask":"q1","decision":"allow","surface":"android"}""",
            Canonical.encode(answerInput("q1", "allow", "android", answers = mapOf("Which report?" to "Q3"))))
        assertEquals("""{"ask":"a1","decision":"always","scope":"project","surface":"android"}""", Canonical.encode(answerInput("a1", "always", "android", scope = "project")))
    }

    @Test fun theGlyphShowsOnlyWhenRequiredAndNotCovered() {
        assertFalse(Gate.glyph(j("""{"id":"a"}""")))
        assertNull(Gate.required(j("""{"id":"a"}""")))
        assertTrue(Gate.glyph(j("""{"presence":{"required":true,"covered":false}}""")))
        assertTrue(Gate.glyph(j("""{"presence":{"required":true}}""")))
        assertFalse(Gate.glyph(j("""{"presence":{"required":true,"covered":true}}""")))
        assertFalse(Gate.glyph(j("""{"presence":{"required":false}}""")))
    }

    @Test fun anAskReadsAsCommandReasonAndFacts() {
        val ask = j("""{"id":"a1","tool":"Bash","summary":"git push origin q3-report","reason":"The report is ready","detail":{"command":"git push -u origin q3-report"},"held_by":"Your rule: pushes ask first"}""")
        assertEquals("git push -u origin q3-report", AskView.command(ask))
        assertEquals("The report is ready", AskView.why(ask))
        assertEquals(listOf("Remote" to "origin", "Branch" to "q3-report", "Held by" to "Your rule: pushes ask first"), AskView.facts(ask).map { it.label to it.value })
        assertEquals("origin" to "main", AskView.push("git push origin HEAD:main"))
        assertNull(AskView.push("npm test"))
        val edit = j("""{"tool":"Edit","summary":"Edit reports/q3.tsx","destination":"reports/q3.tsx","detail":{"file":"reports/q3.tsx","old":"a\nb","new":"c"}}""")
        assertEquals(listOf("File" to "reports/q3.tsx"), AskView.facts(edit).map { it.label to it.value })
        assertEquals(listOf('-' to "a", '-' to "b", '+' to "c"), AskView.diff(edit))
    }

    @Test fun changesReadTotalsElseTheSum() {
        assertEquals("6 files +412 -38", AskView.changes(j("""{"totals":{"files":6,"added":412,"removed":38},"changes":[{"file":"a","added":1,"removed":0}]}"""))!!.line)
        val summed = AskView.changes(j("""{"detail":{"changes":[{"file":"a.ts","added":10,"removed":2},{"file":"b.ts","added":1,"removed":0}]}}"""))!!
        assertEquals("2 files +11 -2", summed.line)
        assertEquals(listOf("a.ts", "b.ts"), summed.list.map { it.file })
        assertNull(AskView.changes(j("""{"tool":"Bash"}""")))
    }

    @Test fun heldReadsInMinutes() {
        assertEquals("Held just now", heldFor(now - 5_000, now))
        assertEquals("Held 4 min", heldFor(now - 240_000, now))
        assertEquals("Held 2 h", heldFor(now - 7_200_000, now))
    }

    @Test fun anchorsRideTheRouteIntoChat() {
        val a = Anchor.of(j("""{"id":"h1","at":$now,"anchor":{"tool_use_id":null,"event":41,"thread":"t1","at":$now}}"""))
        assertEquals(Anchor(null, 41, now), a)
        val route = Anchor.route("t1", a)!!
        assertEquals("thread/t1?ev=41&at=$now", route)
        assertEquals("t1" to a, Anchor.parse(route.removePrefix("thread/")))
        assertEquals("thread/t1", Anchor.route("t1", Anchor()))
        assertNull(Anchor.route("not an id", a))
        // An ask carries no `at` in its anchor: its own `at` stands in.
        assertEquals(Anchor("toolu_9", 7, 5), Anchor.of(j("""{"at":5,"anchor":{"tool_use_id":"toolu_9","event":7}}""")))
    }

    private fun ev(id: Int, at: Long, type: String, payload: String) = flatten(j("""{"id":$id,"at":$at,"type":"$type","payload":{"thread":"t1",$payload}}"""))

    @Test fun openSessionFindsTheToolRowTheEventOrTheTime() {
        val t = Transcript("t1")
        t.add(ev(10, 100, "thread.sent", """"text":"make the report","surface":"android""""))
        t.add(ev(11, 110, "thread.text", """"message":"m1","text":"On it.","done":true"""))
        t.add(ev(12, 120, "thread.tool", """"id":"toolu_1","tool":"Bash","phase":"started","summary":"npm test""""))
        t.add(ev(13, 125, "thread.tool", """"id":"toolu_1","phase":"done","error":false"""))
        t.add(ev(15, 140, "ask.raised", """"ask":"a1","tool":"Bash","summary":"git push origin q3-report""""))
        t.add(ev(16, 150, "thread.text", """"message":"m2","text":"Waiting.","done":true"""))
        assertEquals(2, t.locate(Anchor(toolUseId = "toolu_1")))
        assertEquals(3, t.locate(Anchor(event = 15)))
        // An event no line holds (a gate.held for another item): the first line after it.
        assertEquals(3, t.locate(Anchor(event = 14)))
        assertEquals(1, t.locate(Anchor(at = 105)))
        assertEquals(4, t.locate(Anchor(toolUseId = "toolu_none", event = 16)))
        // Older than what is loaded: not found here, and paging back may find it.
        assertNull(t.locate(Anchor(event = 3)))
        assertTrue(t.older(Anchor(event = 3)))
        assertFalse(t.older(Anchor(event = 15)))
    }
}
