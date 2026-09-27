package sh.vyre.app.data

import kotlinx.serialization.json.JsonObject
import sh.vyre.app.api.input

/**
 * The New agent form (the Deck's newForm, deck/views/agents.js; apps/CONTRACT.md 4.1), as data.
 * Auth is by Vault item name only: nothing secret is typed on the phone. Pure, so its rules are
 * tested on the JVM.
 */
data class NewAgent(
    val name: String = "",
    val projects: Set<String> = emptySet(),
    val job: String = "",
    /** true: a subscription setup token; false: an API key with a budget. */
    val subscription: Boolean = true,
    val subItem: String = SUB_ITEM,
    /** With a subscription: fall back to an API key when its limit is reached. */
    val fallback: Boolean = true,
    val keyItem: String = KEY_ITEM,
    val budget: String = "10",
    val computer: Boolean = false,
) {
    companion object {
        const val SUB_ITEM = "claude-setup-token"
        const val KEY_ITEM = "anthropic-api-key"
        private val NAME = Regex("^[a-z][a-z0-9-]{0,31}$")
    }

    /**
     * The agents.create input, or the sentence that says what to fix. `boxProjects` is every
     * project slug on the box: when there are any, at least one must be ticked.
     */
    fun toInput(boxProjects: Collection<String>): Result<JsonObject> {
        val n = name.trim()
        if (!NAME.matches(n)) return fail("A name is lowercase letters, digits and dashes, starting with a letter, at most 32.")
        val picked = projects.filter { it in boxProjects }
        if (boxProjects.isNotEmpty() && picked.isEmpty()) return fail("Pick at least one project. An agent never sees projects outside its list.")
        val usesBudget = !subscription || fallback
        val b = budget.trim().toDoubleOrNull()
        if (usesBudget && (b == null || b <= 0.0)) return fail("The budget is a number of dollars above zero.")
        val auth: Map<String, Any?> = if (subscription) {
            mapOf("vault" to subItem.trim().ifEmpty { SUB_ITEM }) +
                (if (fallback) mapOf("fallback" to keyItem.trim().ifEmpty { KEY_ITEM }, "budget_usd" to whole(b!!)) else emptyMap())
        } else mapOf("vault" to keyItem.trim().ifEmpty { KEY_ITEM }, "budget_usd" to whole(b!!))
        return Result.success(input(
            "name" to n, "kind" to "agent", "projects" to picked.sorted(), "instructions" to job.trim(),
            "auth" to auth, "computer" to computer,
        ))
    }

    /** 10.0 is sent as 10, as the Deck's Number() does. */
    private fun whole(d: Double): Number = if (d == Math.floor(d) && d < 1e15) d.toLong() else d

    private fun fail(why: String): Result<JsonObject> = Result.failure(IllegalArgumentException(why))
}
