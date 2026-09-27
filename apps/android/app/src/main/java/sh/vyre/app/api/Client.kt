package sh.vyre.app.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Makes a presence header for one call: the device key, behind the fingerprint sheet. */
fun interface Prover {
    /** @param reason the summary the person reads on the sheet before they touch the sensor. */
    suspend fun header(tool: String, input: JsonObject, reason: String): String
}

/**
 * The only thing in the app that makes requests (the same rule as deck/js/api.js). It posts
 * `application/json`, never an Origin and never x-vyre-caller, and turns the envelope into
 * `data` or a typed [ApiError].
 */
class Client(
    private val address: () -> String?,
    private val cache: ReadCache? = null,
    val http: OkHttpClient = defaultHttp(),
) {
    private val _offline = MutableStateFlow(false)
    /** True after a call could not reach the box, until the next one does. */
    val offline: StateFlow<Boolean> = _offline
    private val _lastOk = MutableStateFlow<Long?>(null)
    /** When the box last answered, for "Showing what it said at 12:04". */
    val lastOk: StateFlow<Long?> = _lastOk

    var prover: Prover? = null

    /** A presence.session.open grant for a run of vault reveals: `session id=.. secret=..`. */
    @Volatile var presenceSession: PresenceSession? = null

    fun base(): String = (address() ?: throw ApiError.Offline("No box address yet")).trimEnd('/')

    suspend fun health(): JsonObject = get("/v1/health").obj

    suspend fun tools(): List<String> = get("/v1/tools").arr.mapNotNull { it.str("name") }

    /** POST /v1/tools/<name>. `presence` is the x-vyre-presence header, when the tool needs a person. */
    suspend fun call(tool: String, input: JsonObject = JsonObject(emptyMap()), presence: String? = null, timeoutSec: Long = 30): JsonElement {
        // The body is the canonical form itself, so the input the box hashes is the input that was signed.
        val body = Canonical.encode(input).toRequestBody(JSON)
        val req = Request.Builder().url(base() + "/v1/tools/" + tool).post(body)
            .header("accept", "application/json").apply { if (presence != null) header("x-vyre-presence", presence) }.build()
        return try {
            val out = send(req, timeoutSec)
            cache?.put(tool, input, out)
            out
        } catch (e: ApiError.Offline) {
            cache?.get(tool, input)?.let { return it }
            throw e
        }
    }

    /**
     * A human-only call: signed with the device key after the fingerprint sheet shows `reason`.
     * A retry signs again, since each proof works once.
     */
    suspend fun callProved(tool: String, input: JsonObject = JsonObject(emptyMap()), reason: String, timeoutSec: Long = 60): JsonElement {
        val p = prover ?: throw ApiError.PresenceRequired("This phone has no device key yet", listOf("device"))
        return call(tool, input, p.header(tool, input, reason), timeoutSec)
    }

    /**
     * Tools this box would not let a presence session prove (it answered "needs its own proof"),
     * so the next proof for one goes straight to the call instead of opening a session first.
     */
    var rules: SessionRules = MemoryRules()

    /**
     * A call a person may have to answer for (the user's no-nag rule, absolute): the fingerprint
     * only for pairing, vault secrets and sending, posting or paying outside, and only when no live
     * presence session on this phone covers it. The app never guesses from the tool name:
     *
     * 1. With `session` and a live presence session, the call rides it (`session id=.. secret=..`).
     * 2. Unless the box said a proof is `required`, the call goes plainly.
     * 3. Only when the box answers presence_required does the fingerprint sheet show, once. With
     *    `session`, that one proof opens presence.session.open and the call retries on the new
     *    session, so later calls within about 30 minutes skip the sheet; a box that will not take a
     *    session for this tool gets the tool's own proof (and is remembered, [rules]). Without
     *    `session` (agents.create, a harmless fallback), the proof signs the call, retried once.
     *
     * `prompt` false never shows the sheet: a call that needs one throws PresenceRequired.
     * `check` runs before each attempt that carries a proof (floor rule 1: what was shown is what goes).
     */
    suspend fun callOrProve(tool: String, input: JsonObject, reason: String, timeoutSec: Long = 60, required: Boolean? = null,
                            session: Boolean = false, prompt: Boolean = true, check: (suspend () -> Unit)? = null): JsonElement {
        var needed = required == true
        if (session) presenceSession?.takeIf { it.live() && !rules.refused(tool) }?.let { s ->
            try { check?.invoke(); return call(tool, input, s.header(), timeoutSec).also { s.touch() } }
            catch (e: ApiError.PresenceRequired) { learn(tool, e); needed = true }
        }
        if (!needed) {
            try { return call(tool, input, null, timeoutSec) }
            catch (e: ApiError.PresenceRequired) { if (!prompt) throw e }
        } else if (!prompt) throw ApiError.PresenceRequired("This needs your fingerprint", listOf("device"))
        val p = prover ?: throw ApiError.PresenceRequired("This phone has no device key yet", listOf("device"))
        if (session && presenceSession?.live() != true && !rules.refused(tool)) {
            val open = JsonObject(emptyMap())
            val s = PresenceSession.of(call("presence.session.open", open, p.header("presence.session.open", open, reason), timeoutSec))
            presenceSession = s
            if (s != null) try { check?.invoke(); return call(tool, input, s.header(), timeoutSec).also { s.touch() } }
            catch (e: ApiError.PresenceRequired) { learn(tool, e) }
        }
        val h = p.header(tool, input, reason)
        check?.invoke()
        return call(tool, input, h, timeoutSec)
    }

    /** A session refused for this tool is remembered; one that ended is dropped. */
    private fun learn(tool: String, e: ApiError.PresenceRequired) {
        if (e.message.contains("own proof")) rules.refuse(tool) else presenceSession = null
    }

    /** vault.reveal / vault.totp inside an open presence session, else a device proof for this item. */
    suspend fun callVault(tool: String, input: JsonObject, reason: String): JsonElement {
        val s = presenceSession?.takeIf { it.live() }
        if (s != null) {
            try { return call(tool, input, s.header()).also { s.touch() } }
            catch (e: ApiError.PresenceRequired) { presenceSession = null }
        }
        return callProved(tool, input, reason)
    }

    /** A plain JSON POST to a path that is not a tool (the debug test world's /__test/code). */
    suspend fun post(path: String, body: JsonObject = JsonObject(emptyMap())): JsonElement =
        send(Request.Builder().url(base() + path).post(Canonical.encode(body).toRequestBody(JSON)).header("accept", "application/json").build(), 15)

    private suspend fun get(path: String): JsonElement = send(Request.Builder().url(base() + path).get().header("accept", "application/json").build(), 15)

    private suspend fun send(req: Request, timeoutSec: Long): JsonElement = withContext(Dispatchers.IO) {
        val c = http.newBuilder().readTimeout(timeoutSec, TimeUnit.SECONDS).callTimeout(timeoutSec + 10, TimeUnit.SECONDS).build()
        val resp = try { c.newCall(req).await() } catch (e: IOException) {
            _offline.value = true
            throw ApiError.Offline(e.message ?: "unreachable")
        }
        _offline.value = false
        _lastOk.value = System.currentTimeMillis()
        resp.use { r -> decode(r.code, r.body?.string().orEmpty()) }
    }

    companion object {
        val JSON = "application/json".toMediaType()

        fun defaultHttp(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
            .followRedirects(false).retryOnConnectionFailure(true).build()

        /** The envelope: `{data}` or `{error:{code,message,methods?}}`. Pure, so it is tested on the JVM. */
        fun decode(status: Int, text: String): JsonElement {
            val parsed = try { JsonCodec.parseToJsonElement(text) } catch (_: Exception) { null }
            val err = parsed.at("error")
            if (err != null || status !in 200..299) {
                throw ApiError.of(status, err.str("code") ?: statusCode(status), err.str("message") ?: text.take(200).ifBlank { null }, err.strings("methods"))
            }
            return parsed.at("data") ?: JsonNull
        }

        private fun statusCode(status: Int) = when (status) { 404 -> "no_such_tool"; 400 -> "bad_input"; 403 -> "denied"; 421 -> "misdirected"; else -> "failed" }
    }
}

data class PresenceSession(val id: String, val secret: String, val expires: Long, val idleMs: Long, var lastUsed: Long = System.currentTimeMillis()) {
    fun live(now: Long = System.currentTimeMillis()) = now < expires && now - lastUsed < idleMs
    fun touch() { lastUsed = System.currentTimeMillis() }
    fun header() = "session id=$id secret=$secret"

    companion object {
        /** presence.session.open's `{session, secret, expires, idle}`; expiry is kept a minute short of the box's. */
        fun of(out: JsonElement): PresenceSession? {
            val id = out.str("session") ?: return null
            val secret = out.str("secret") ?: return null
            return PresenceSession(id, secret, (out.long("expires") ?: (System.currentTimeMillis() + 30 * 60_000L)) - 60_000L, (out.long("idle") ?: 300_000L) - 15_000L)
        }
    }
}

/** What Client.callOrProve learned about presence sessions on this box. */
interface SessionRules {
    fun refused(tool: String): Boolean
    fun refuse(tool: String)
}

/** For this run of the app: a box that is upgraded to take sessions for more tools is tried again next launch. */
class MemoryRules : SessionRules {
    private val tools = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    override fun refused(tool: String) = tool in tools
    override fun refuse(tool: String) { tools += tool }
}

/** The offline cache Client consults when the box is out of reach. See data/Cache.kt. */
interface ReadCache {
    fun put(tool: String, input: JsonObject, data: JsonElement)
    fun get(tool: String, input: JsonObject): JsonElement?
}

suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    enqueue(object : Callback {
        override fun onResponse(call: Call, response: Response) { cont.resume(response) }
        override fun onFailure(call: Call, e: IOException) { if (!cont.isCancelled) cont.resumeWithException(e) }
    })
    cont.invokeOnCancellation { runCatching { cancel() } }
}
