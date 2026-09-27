package sh.vyre.app

import kotlinx.serialization.json.JsonElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import sh.vyre.app.api.JsonCodec
import sh.vyre.app.data.Speaker

class SpeakerTest {
    private fun j(s: String): JsonElement = JsonCodec.parseToJsonElement(s)
    private val agents = listOf(j("""{"name":"juno","kind":"assistant"}"""), j("""{"name":"kit","kind":"agent"}"""))

    @Test fun assistantFromSystemInfoNullMeansVyre() {
        assertEquals("alex's helper", Speaker.assistant(agents, j("""{"assistant":{"name":"alex's helper"}}""")))
        assertEquals("Vyre", Speaker.assistant(agents, j("""{"assistant":{"name":null}}""")))
        // Only a box whose system.info could not be read falls back to agents.list.
        assertEquals("juno", Speaker.assistant(agents, null))
        assertEquals("Harlow", Speaker.assistant(emptyList(), j("""{"assistant":{"name":"Harlow"}}""")))
        assertEquals("Harlow", Speaker.assistant(emptyList(), j("""{"assistant":"Harlow"}""")))
        assertEquals("Vyre", Speaker.assistant(emptyList(), j("""{"owner":{"name":"Alex"}}""")))
        assertEquals("Vyre", Speaker.assistant(emptyList(), null))
    }

    @Test fun repliesAreByTheThreadsAgentOrTheAssistant() {
        assertEquals("kit", Speaker.reply("kit", "juno"))
        assertEquals("juno", Speaker.reply(null, "juno"))
        assertEquals("Vyre", Speaker.reply(null, ""))
    }

    @Test fun messagesAreYouOrTheAgentThatTyped() {
        assertEquals("you", Speaker.sender(null, "juno"))
        assertEquals("you", Speaker.sender("android", "juno"))
        assertEquals("you", Speaker.sender("tailnet:alex@example.com", "juno"))
        assertEquals("kit", Speaker.sender("agent:kit", "juno"))
    }

    @Test fun claudeNeverAppears() {
        assertEquals("juno", Speaker.reply("claude", "juno"))
        assertEquals("Vyre", Speaker.reply("Claude", "claude"))
        assertEquals("juno", Speaker.assistant(listOf(j("""{"name":"claude","kind":"assistant"}""")), j("""{"assistant":"juno"}""")))
        assertEquals("juno", Speaker.sender("agent:claude", "juno"))
        assertEquals("sonnet-4-5", Speaker.model("claude-sonnet-4-5"))
        assertEquals(null, Speaker.model("claude"))
        for (s in listOf(Speaker.reply("claude", "Claude Code"), Speaker.sender("agent:CLAUDE", "claude"), Speaker.model("Claude Opus").orEmpty()))
            assertFalse(s, s.contains("claude", ignoreCase = true))
    }
}
