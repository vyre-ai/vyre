package sh.vyre.app

import org.junit.Assert.assertEquals
import org.junit.Test
import sh.vyre.app.data.initials

class FormatTest {
    @Test fun initialsFromOwner() {
        assertEquals("AR", initials("Alex Rivera", "vyre.example.ts.net"))
        assertEquals("A", initials("alex", null))
        assertEquals("JK", initials("  juno  de kit ", null))
    }

    @Test fun initialsFallBackToHost() {
        assertEquals("V", initials(null, "vyre.example.ts.net"))
        assertEquals("V", initials("   ", "vyre.example.ts.net"))
        assertEquals("V", initials(null, null))
    }
}
