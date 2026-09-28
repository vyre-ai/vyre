// The fill listener's client (core/vault/fill.js). JSON over https, `{ data }` or
// `{ error: { code, message } }` back. Authorization carries the device token, X-Vyre-Session the
// fill window. Nothing here logs: a body can carry a value, and an error message is the server's
// own words, which never carry one.

package sh.vyre.autofill

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** A refusal from vyred (its error code), or a failure to reach it (code "network"). */
class FillError(val code: String, message: String, val status: Int = 0) : Exception(message)

class FillClient(private val server: String, private val token: String?) {
  /**
   * POST a route. `timeoutMs` bounds the connect and the read each; the autofill service passes
   * what is left of its budget.
   */
  fun post(route: String, body: JSONObject, session: String? = null, timeoutMs: Int = 10_000): JSONObject =
    call("POST", route, body, session, timeoutMs)

  fun get(route: String, session: String? = null, timeoutMs: Int = 10_000): JSONObject =
    call("GET", route, null, session, timeoutMs)

  private fun call(method: String, route: String, body: JSONObject?, session: String?, timeoutMs: Int): JSONObject {
    val url = URL(AutofillCore.routeUrl(server, route))
    val c = try { url.openConnection() as HttpURLConnection } catch (e: IOException) {
      throw FillError("network", "could not reach vyred")
    }
    try {
      c.requestMethod = method
      c.connectTimeout = timeoutMs.coerceAtLeast(200)
      c.readTimeout = timeoutMs.coerceAtLeast(200)
      c.useCaches = false
      c.instanceFollowRedirects = false
      c.setRequestProperty("accept", "application/json")
      if (token != null) c.setRequestProperty("authorization", "Bearer $token")
      if (session != null) c.setRequestProperty("x-vyre-session", session)
      if (body != null) {
        val bytes = body.toString().toByteArray(Charsets.UTF_8)
        c.doOutput = true
        c.setRequestProperty("content-type", "application/json")
        c.setFixedLengthStreamingMode(bytes.size)
        c.outputStream.use { it.write(bytes) }
      }
      val status = c.responseCode
      val stream = if (status in 200..299) c.inputStream else c.errorStream
      val text = stream?.use { s -> s.readBytes().toString(Charsets.UTF_8) } ?: ""
      val json = try { JSONObject(text) } catch (e: Exception) {
        throw FillError("bad_reply", "vyred answered $status without JSON", status)
      }
      json.optJSONObject("error")?.let { e ->
        throw FillError(e.optString("code", "error"), e.optString("message", "refused"), status)
      }
      if (status !in 200..299) throw FillError("http_$status", "vyred answered $status", status)
      return json.optJSONObject("data") ?: JSONObject()
    } catch (e: FillError) {
      throw e
    } catch (e: IOException) {
      throw FillError("network", "could not reach vyred")
    } finally {
      c.disconnect()
    }
  }
}
