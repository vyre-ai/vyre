package sh.vyre.app

import org.junit.Assert.assertEquals
import org.junit.Test
import sh.vyre.app.api.JsonCodec
import sh.vyre.app.data.Need
import sh.vyre.app.data.Needs

class NeedsTest {
    private fun j(s: String) = JsonCodec.parseToJsonElement(s)
    private val now = 1_800_000_000_000L

    @Test fun askTitlesAreActions() {
        assertEquals("Push q3-report", Needs.askTitle("Bash", "git push origin q3-report", null))
        assertEquals("Run npm test", Needs.askTitle("Bash", "npm test", null))
        assertEquals("Run npm build", Needs.askTitle("Bash", "npm run build", null))
        assertEquals("Delete old.log", Needs.askTitle("Bash", "rm -f logs/old.log", null))
        assertEquals("Edit q3.tsx", Needs.askTitle("Edit", "Edit reports/q3.tsx", "reports/q3.tsx"))
        assertEquals("Fetch api.example.com", Needs.askTitle("WebFetch", "fetch https://api.example.com/v1/x", null))
        assertEquals("Use Glob", Needs.askTitle("Glob", "Glob pattern: **/*.ts", null))
    }

    @Test fun draftTitlesNameThePerson() {
        assertEquals("Send email to Dana", Needs.draftTitle(j("""{"kind":"send","to":["dana@harlowlegal.com"]}""")))
        assertEquals("Send email to Dana and 2 others", Needs.draftTitle(j("""{"kind":"send","to":["dana.reyes@harlowlegal.com","a@b.c","d@e.f"]}""")))
        assertEquals("Approve a spend", Needs.draftTitle(j("""{"kind":"spend","to":["billing"]}""")))
    }

    @Test fun rowsAreOldestFirstWithTheAsksAgent() {
        val held = listOf(j("""{"id":"h1","kind":"send","via":"gmail","to":["dana@harlowlegal.com"],"summary":"Q3 report, the short version","agent":"kit","project":"harlow-legal","at":${now - 720_000}}"""))
        val asks = listOf(j("""{"id":"a1","thread":"t1","tool":"Bash","summary":"git push origin q3-report","at":${now - 240_000}}"""),
            j("""{"id":"a0","thread":"t1","tool":"Bash","summary":"npm test","at":${now - 900_000}}"""))
        val rows = Needs.rows(held, asks, { if (it == "t1") "juno" else null }, { if (it == "t1") "Northwind Bakery" else null })
        assertEquals(listOf("a0", "h1", "a1"), rows.map { it.id })
        assertEquals(Need.Kind.Draft, rows[1].kind)
        assertEquals("Q3 report, the short version", rows[1].line)
        assertEquals("Send", rows[1].yes); assertEquals("Discard", rows[1].no)
        assertEquals("Approve", rows[2].yes); assertEquals("Deny", rows[2].no)
        assertEquals("juno", rows[2].agent); assertEquals("J", rows[2].initial)
        assertEquals("12m", Needs.short(rows[1].at, now))
    }

    @Test fun talkBackReadsTheRowWhole() {
        val n = Needs.rows(emptyList(), listOf(j("""{"id":"a1","thread":"t1","tool":"Bash","summary":"git push origin q3-report","at":${now - 240_000}}""")),
            { "kit" }, { "Harlow Legal" }).single()
        assertEquals("kit, Harlow Legal, wants to push q3-report, git push origin q3-report, 4 minutes ago.", Needs.label(n, now))
    }
}
