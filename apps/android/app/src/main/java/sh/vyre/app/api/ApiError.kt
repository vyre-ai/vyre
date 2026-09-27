package sh.vyre.app.api

/** The box's error envelope, typed. Screens say what happened in plain words from these. */
sealed class ApiError(val code: String, override val message: String) : Exception(message) {
    /** 403 presence_required: a person must prove they are here. `methods` lists what the box accepts. */
    class PresenceRequired(message: String, val methods: List<String>) : ApiError("presence_required", message)
    class Denied(message: String) : ApiError("denied", message)
    class NotOwner(message: String) : ApiError("not_owner", message)
    class Misdirected(message: String) : ApiError("misdirected", message)
    class NoSuchTool(message: String) : ApiError("no_such_tool", message)
    class BadInput(message: String) : ApiError("bad_input", message)
    /** Could not reach the box at all: no network, Tailscale off, the box down. */
    class Offline(message: String) : ApiError("offline", message)
    /** The person dismissed the fingerprint sheet. Not an error to show loudly. */
    class Cancelled : ApiError("cancelled", "Cancelled")
    class Other(code: String, message: String, val status: Int) : ApiError(code, message)

    companion object {
        fun of(status: Int, code: String?, message: String?, methods: List<String>): ApiError {
            val m = message?.takeIf { it.isNotBlank() } ?: "The box answered $status"
            return when (code) {
                "presence_required" -> PresenceRequired(m, methods)
                "denied" -> Denied(m)
                "not_owner" -> NotOwner(m)
                "misdirected" -> Misdirected(m)
                "no_such_tool" -> NoSuchTool(m)
                "bad_input" -> BadInput(m)
                else -> Other(code ?: "failed", m, status)
            }
        }
    }
}

/** What a person reads when a call fails. Short and plain. */
fun Throwable.plain(): String = when (this) {
    is ApiError.Offline -> "Can't reach the box. Check that Tailscale is on."
    is ApiError.NotOwner -> "This box serves only its owner. Sign in to Tailscale as the owner."
    is ApiError.Misdirected -> "That address is not this box's name."
    is ApiError.PresenceRequired -> "This needs your fingerprint on this phone."
    is ApiError.Cancelled -> "Cancelled."
    is ApiError -> message
    else -> message ?: "Something went wrong."
}
