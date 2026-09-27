package sh.vyre.app.data

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import sh.vyre.app.api.Canonical
import sh.vyre.app.api.JsonCodec
import sh.vyre.app.api.ReadCache
import sh.vyre.app.api.str
import java.io.File

/**
 * The offline cache, the Deck's rule (ADR 0018 section 6): projects.list, agents.list, and
 * threads.get for threads the person opened, at most 20 threads and 7 days. It lives in the app's
 * private files (excluded from backup in the manifest and data_extraction_rules.xml). Nothing
 * else is ever written: no held item, no vault value, no memory fact, no file.
 */
class Cache(private val dir: File, private val now: () -> Long = System::currentTimeMillis) : ReadCache {
    init { dir.mkdirs() }

    override fun put(tool: String, input: JsonObject, data: JsonElement) {
        val name = fileFor(tool, input) ?: return
        runCatching { File(dir, name).writeText(Canonical.encode(data)) }
        if (tool == "threads.get") prune()
    }

    override fun get(tool: String, input: JsonObject): JsonElement? {
        val f = File(dir, fileFor(tool, input) ?: return null)
        if (!f.exists() || now() - f.lastModified() > WEEK) return null
        return runCatching { JsonCodec.parseToJsonElement(f.readText()) }.getOrNull()
    }

    /** Oldest threads beyond 20, and anything older than 7 days, are deleted. */
    fun prune() {
        val files = dir.listFiles().orEmpty()
        files.filter { now() - it.lastModified() > WEEK }.forEach { it.delete() }
        files.filter { it.exists() && it.name.startsWith("thread-") }.sortedByDescending { it.lastModified() }.drop(MAX_THREADS).forEach { it.delete() }
    }

    fun wipe() { dir.listFiles().orEmpty().forEach { it.delete() } }

    fun files(): List<String> = dir.listFiles().orEmpty().map { it.name }.sorted()

    companion object {
        const val MAX_THREADS = 20
        const val WEEK = 7L * 24 * 3600 * 1000

        /** Only the three cacheable reads have a file; everything else returns null and is never written. */
        fun fileFor(tool: String, input: JsonObject): String? = when (tool) {
            "projects.list" -> "projects.json"
            "agents.list" -> "agents.json"
            "threads.get" -> input.str("thread")?.takeIf { Regex("^[A-Za-z0-9_-]{1,128}$").matches(it) && input.str("since").let { s -> s == null || s == "0" } }?.let { "thread-$it.json" }
            else -> null
        }
    }
}
