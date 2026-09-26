package sh.vyre.app.api

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import okhttp3.Request
import java.io.IOException
import java.util.concurrent.TimeUnit

/** One Server-Sent Event: `id`, `event` and the joined `data` lines. */
data class SseFrame(val id: String?, val event: String?, val data: String)

/**
 * A line-by-line SSE reader (the WHATWG rules the box needs): `field: value` with one optional
 * space after the colon, `:` comments ignored, data lines joined with \n, a blank line ends the
 * frame, CR, LF and CRLF all end a line. Pure, so it is tested on the JVM.
 */
class SseParser {
    private var id: String? = null
    private var event: String? = null
    private val data = StringBuilder()
    private var hasData = false
    /** The last id seen, kept across frames, as the browser keeps lastEventId. */
    var lastId: String? = null
        private set

    fun line(raw: String): SseFrame? {
        val line = raw.removeSuffix("\r")
        if (line.isEmpty()) return dispatch()
        if (line.startsWith(":")) return null
        val colon = line.indexOf(':')
        val field = if (colon < 0) line else line.substring(0, colon)
        var value = if (colon < 0) "" else line.substring(colon + 1)
        if (value.startsWith(" ")) value = value.substring(1)
        when (field) {
            "id" -> if (!value.contains('\u0000')) id = value
            "event" -> event = value
            "data" -> { if (hasData) data.append('\n'); data.append(value); hasData = true }
        }
        return null
    }

    /** Feed a chunk that may hold several lines or part of one. */
    private val partial = StringBuilder()
    fun feed(chunk: String): List<SseFrame> {
        val out = mutableListOf<SseFrame>()
        partial.append(chunk)
        while (true) {
            val i = partial.indexOfFirst { it == '\n' || it == '\r' }
            if (i < 0) break
            val crlf = partial[i] == '\r' && i + 1 < partial.length && partial[i + 1] == '\n'
            if (partial[i] == '\r' && i + 1 == partial.length) break // wait: it may be CRLF split across chunks
            val l = partial.substring(0, i)
            partial.delete(0, i + if (crlf) 2 else 1)
            line(l)?.let(out::add)
        }
        return out
    }

    private fun dispatch(): SseFrame? {
        if (id != null) lastId = id
        val f = if (hasData) SseFrame(id ?: lastId, event, data.toString()) else null
        id = null; event = null; data.setLength(0); hasData = false
        return f
    }
}

/** Reconnect delays: 1 s doubling to 30 s, with a little jitter so two phones do not beat in step. */
class Backoff(private val base: Long = 1_000, private val max: Long = 30_000, private val jitter: () -> Double = { Math.random() }) {
    private var n = 0
    fun next(): Long { val d = (base shl n.coerceAtMost(5)).coerceAtMost(max); n++; return d + (d * 0.2 * jitter()).toLong() }
    fun reset() { n = 0 }
}

/**
 * The one live connection: GET /v1/events/stream, resumed with Last-Event-ID. [start] when the app
 * comes to the front, [stop] when it leaves (the activity's STARTED state drives both); nothing
 * reads in the background.
 */
class EventStream(private val client: Client, private val scope: CoroutineScope) {
    private val _events = MutableSharedFlow<JsonObject>(extraBufferCapacity = 256)
    /** Flattened events: payload fields at the top, the event id as `event`. */
    val events: SharedFlow<JsonObject> = _events
    private val _connected = MutableStateFlow(false)
    val connected: StateFlow<Boolean> = _connected

    @Volatile var lastId: String? = null
    private var job: Job? = null
    @Volatile private var call: okhttp3.Call? = null

    fun start() {
        if (job?.isActive == true) return
        job = scope.launch(Dispatchers.IO) { loop() }
    }

    fun stop() {
        job?.cancel(); job = null
        call?.cancel(); call = null
        _connected.value = false
    }

    private suspend fun loop() {
        val backoff = Backoff()
        if (lastId == null) lastId = runCatching { client.health().str("last_event") }.getOrNull()
        while (kotlinx.coroutines.currentCoroutineContext().isActive) {
            try {
                val since = lastId ?: "latest"
                val req = Request.Builder().url(client.base() + "/v1/events/stream?since=" + since)
                    .header("accept", "text/event-stream").apply { lastId?.let { header("Last-Event-ID", it) } }.build()
                val http = client.http.newBuilder().readTimeout(45, TimeUnit.SECONDS).build()
                val c = http.newCall(req); call = c
                c.execute().use { r ->
                    if (!r.isSuccessful) throw IOException("stream ${r.code}")
                    _connected.value = true
                    val src = r.body!!.source()
                    val parser = SseParser()
                    while (true) {
                        val l = src.readUtf8Line() ?: break
                        val f = parser.line(l) ?: continue
                        backoff.reset()
                        f.id?.let { lastId = it }
                        val ev = runCatching { JsonCodec.parseToJsonElement(f.data) }.getOrNull() ?: continue
                        _events.emit(flatten(ev))
                    }
                }
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
            }
            _connected.value = false
            delay(backoff.next())
        }
    }
}
