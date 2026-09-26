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

    /** vault.reveal / vault.totp inside an open presence session, else a device proof for this item. */
    suspend fun callVault(tool: String, input: JsonObject, reason: String): JsonElement {
        val s = presenceSession?.takeIf { it.live() }
        if (s != null) {
            try { return call(tool, input, "session id=${s.id} secret=${s.secret}").also { s.touch() } }
            catch (e: ApiError.PresenceRequired) { presenceSession = null }
        }
        return callProved(tool, input, reason)
    }

    private suspend fun get(path: String): JsonElement = send(Request.Builder().url(base() + path).get().header("accept", "application/json").build(), 15)

    private suspend fun send(req: Request, timeoutSec: Long): JsonElement = withContext(Dispatchers.IO) {
        val c = http.newBuilder().readTimeout(timeoutSec, TimeUnit.SECONDS).callTimeout(timeoutSec + 10, TimeUnit.SECONDS).build()
        val resp = try { c.newCall(req).await() } catch (e: IOException) {
            _offline.value = true
            throw ApiError.Offline(e.message ?: "unreachable")
        }
        _offline.value = false
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
