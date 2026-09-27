package sh.vyre.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import sh.vyre.app.api.JsonCodec
import sh.vyre.app.api.input
import sh.vyre.app.api.str
import sh.vyre.app.data.Cache
import sh.vyre.app.push.Seal
import java.io.File
import java.nio.file.Files

class CacheSealTest {
    @Test fun cachesOnlyTheThreeReads() {
        assertEquals("projects.json", Cache.fileFor("projects.list", input()))
        assertEquals("agents.json", Cache.fileFor("agents.list", input()))
        assertEquals("thread-t1.json", Cache.fileFor("threads.get", input("thread" to "t1")))
        for (t in listOf("gate.get", "gate.held", "vault.reveal", "vault.list", "memory.facts", "files.fetch", "threads.list", "recall.search"))
            assertNull(t, Cache.fileFor(t, input("thread" to "t1")))
        assertNull(Cache.fileFor("threads.get", input("thread" to "../x")))
        assertNull(Cache.fileFor("threads.get", input("thread" to "t1", "since" to 40)))
    }

    @Test fun twentyThreadsAndSevenDays() {
        val dir: File = Files.createTempDirectory("vy-cache").toFile()
        var now = 1_000_000_000_000L
        val c = Cache(dir) { now }
        for (i in 1..25) {
            c.put("threads.get", input("thread" to "t$i"), JsonCodec.parseToJsonElement("""{"thread":{"id":"t$i"}}"""))
            File(dir, "thread-t$i.json").setLastModified(now - (25 - i) * 1000L)
        }
        c.prune()
        assertEquals(20, dir.listFiles()!!.count { it.name.startsWith("thread-") })
        assertNull(c.get("threads.get", input("thread" to "t1")))
        c.put("projects.list", input(), JsonCodec.parseToJsonElement("""{"projects":[]}"""))
        File(dir, "projects.json").setLastModified(now)
        assertEquals("""[]""", c.get("projects.list", input())!!.let { (it as kotlinx.serialization.json.JsonObject)["projects"].toString() })
        now += Cache.WEEK + 1
        assertNull(c.get("projects.list", input()))
        c.put("gate.get", input("id" to "x"), JsonCodec.parseToJsonElement("{}"))
        assertEquals(false, File(dir, "gate.get").exists())
        dir.deleteRecursively()
    }

    @Test fun sealOpensOnlyWithItsKeyAndOnlyKnownPaths() {
        val key = ByteArray(32) { it.toByte() }
        val iv = ByteArray(12) { 7 }
        val s = Seal.seal(key, """{"path":"/needs/a1b2c3d4e5f6a7b8c9","tag":"draft-a1b2c3d4e5f6a7b8c9","at":1790000000000}""", iv)
        val o = Seal.open(key, s)!!
        assertEquals("/needs/a1b2c3d4e5f6a7b8c9", o.path); assertEquals(1790000000000, o.at)
        assertNull(Seal.open(ByteArray(32), s))
        assertNull(Seal.open(key, Seal.seal(key, """{"path":"https://example.com/x"}""", iv)))
        assertNull(Seal.open(key, "AAAA"))
        assertEquals("draft-a1b2c3d4e5f6a7b8c9", o.tag)
        assertEquals(null, input().str("x"))
    }
}
