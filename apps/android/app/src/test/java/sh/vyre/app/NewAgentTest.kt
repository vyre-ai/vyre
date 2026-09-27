package sh.vyre.app

import kotlinx.coroutines.runBlocking
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
import sh.vyre.app.api.Prover
import sh.vyre.app.api.input
import sh.vyre.app.api.str
import sh.vyre.app.data.NewAgent

class NewAgentTest {
    private val box = listOf("harlow-legal", "northwind-bakery")

    @Test fun theNameRuleIsCheckedBeforeSending() {
        for (bad in listOf("", "Kit", "9lives", "kit juno", "a".repeat(33), "-kit"))
            assertTrue(bad, NewAgent(name = bad, projects = setOf("harlow-legal")).toInput(box).isFailure)
        assertTrue(NewAgent(name = "kit-2", projects = setOf("harlow-legal")).toInput(box).isSuccess)
    }

    @Test fun atLeastOneProjectWhenTheBoxHasAny() {
        assertEquals("Pick at least one project. An agent never sees projects outside its list.",
            NewAgent(name = "kit").toInput(box).exceptionOrNull()?.message)
        assertTrue(NewAgent(name = "kit").toInput(emptyList()).isSuccess)
    }

    @Test fun subscriptionWithFallbackIsItemNamesAndABudget() {
        val i = NewAgent(name = "kit", projects = setOf("northwind-bakery", "harlow-legal"), job = " Books the bakery's orders. ", budget = "25").toInput(box).getOrThrow()
        assertEquals("""{"auth":{"budget_usd":25,"fallback":"anthropic-api-key","vault":"claude-setup-token"},"computer":false,"instructions":"Books the bakery's orders.","kind":"agent","name":"kit","projects":["harlow-legal","northwind-bakery"]}""",
            Canonical.encode(i))
    }

    @Test fun subscriptionAloneHasNoBudget() {
        val i = NewAgent(name = "kit", projects = setOf("harlow-legal"), fallback = false, budget = "").toInput(box).getOrThrow()
        assertEquals("""{"vault":"claude-setup-token"}""", Canonical.encode(i["auth"]!!))
    }

    @Test fun apiKeyNeedsABudgetAboveZero() {
        assertTrue(NewAgent(name = "kit", projects = setOf("harlow-legal"), subscription = false, budget = "0").toInput(box).isFailure)
        val i = NewAgent(name = "kit", projects = setOf("harlow-legal"), subscription = false, keyItem = "northwind-key", budget = "12.5", computer = true).toInput(box).getOrThrow()
        assertEquals("""{"budget_usd":12.5,"vault":"northwind-key"}""", Canonical.encode(i["auth"]!!))
        assertEquals("true", i.str("computer"))
    }

    private fun refused() = MockResponse().setResponseCode(403).setBody("""{"error":{"code":"presence_required","message":"agents.create needs a person","methods":["device"]}}""")

    @Test fun presenceRequiredLeadsToExactlyOneSignedRetry() = runBlocking {
        val server = MockWebServer()
        server.enqueue(refused())
        server.enqueue(MockResponse().setBody("""{"data":{"name":"kit"}}"""))
        server.start()
        try {
            val client = Client({ server.url("/").toString() })
            var signed = 0
            client.prover = Prover { tool, _, _ -> signed++; "device key=k1 ts=1 nonce=n0nce123 sig=$tool" }
            val out = client.callOrProve("agents.create", input("name" to "kit"), "Create kit")
            assertEquals("kit", out.str("name"))
            assertEquals(1, signed)
            assertEquals(2, server.requestCount)
            assertNull(server.takeRequest().getHeader("x-vyre-presence"))
            assertEquals("device key=k1 ts=1 nonce=n0nce123 sig=agents.create", server.takeRequest().getHeader("x-vyre-presence"))
        } finally { server.shutdown() }
    }

    @Test fun aSecondRefusalIsNotRetriedAgain() = runBlocking {
        val server = MockWebServer()
        server.enqueue(refused()); server.enqueue(refused()); server.enqueue(MockResponse().setBody("""{"data":{}}"""))
        server.start()
        try {
            val client = Client({ server.url("/").toString() })
            var signed = 0
            client.prover = Prover { _, _, _ -> signed++; "device key=k1 ts=1 nonce=n0nce123 sig=x" }
            try { client.callOrProve("agents.create", input("name" to "kit"), "Create kit"); fail("no error") } catch (e: ApiError.PresenceRequired) { }
            assertEquals(1, signed)
            assertEquals(2, server.requestCount)
        } finally { server.shutdown() }
    }
}
