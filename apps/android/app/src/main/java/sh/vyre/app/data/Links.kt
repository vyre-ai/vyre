package sh.vyre.app.data

/** Where a link opens in the app. Pure, so it is tested on the JVM. */
object Links {
    private val TABS = setOf("now", "chats", "agents", "find")
    private val ID = Regex("^[A-Za-z0-9_-]{1,128}$")

    /**
     * An in-app route for a push path (`/needs/<id>`, `/threads/<id>`, `/settings?...`, CONTRACT.md 7)
     * or a `vyre://` link (`vyre://needs/<id>`, `vyre://threads/<id>`, `vyre://settings`,
     * `vyre://find` and the other tabs). Null for anything else, including `vyre://enrolled`, which sign-in reads.
     */
    fun route(link: String?): String? {
        if (link.isNullOrBlank()) return null
        val path = when {
            link.startsWith("vyre://") -> "/" + link.removePrefix("vyre://")
            link.startsWith("/") -> link
            else -> return null
        }
        val clean = path.substringBefore('?').substringBefore('#').trimEnd('/')
        val parts = clean.split('/').filter { it.isNotEmpty() }
        return when {
            parts.size == 2 && parts[0] == "needs" && ID.matches(parts[1]) -> "needs/${parts[1]}"
            parts.size == 2 && parts[0] == "threads" && ID.matches(parts[1]) -> "thread/${parts[1]}"
            parts.size == 1 && parts[0] == "settings" -> "settings"
            parts.size == 1 && parts[0] in TABS -> "tab/${parts[0]}"
            // Older names: Chat and Projects became Chats (projects are its chips), the Capsule and
            // Files became Find (the Capsule, opened), More became Now's avatar.
            parts.size == 1 && parts[0] in setOf("chat", "projects") -> "tab/chats"
            parts.size == 1 && parts[0] in setOf("capsule", "files") -> "tab/find"
            parts.size == 1 && parts[0] == "more" -> "tab/now"
            else -> null
        }
    }

    /**
     * The page a route opens over (phone.md section 3: Now, Chats, Agents): a held item or an ask
     * on Now, a session or a project on Chats (the exact session pushed over the list, so back
     * lands on it), an agent on Agents. `tab/find` is the Capsule, opened; Settings is a sheet over Now.
     */
    fun tabOf(route: String): String = when {
        route.startsWith("tab/") -> route.removePrefix("tab/")
        route.startsWith("thread/") || route.startsWith("project/") -> "chats"
        route.startsWith("agent/") -> "agents"
        else -> "now"
    }

    /** The route into one Chat session, or null when the id is not one. */
    fun session(thread: String?): String? = thread?.takeIf { ID.matches(it) }?.let { "thread/$it" }

    /**
     * A box address as the app stores it: `https://<host>[:port]`, no path. A bare name gets
     * https. Plain http is kept only when typed (the debug test world). Null when it is not one.
     */
    fun address(raw: String): String? {
        val t = raw.trim().trimEnd('/')
        if (t.isEmpty() || t.any { it.isWhitespace() }) return null
        val withScheme = if (t.startsWith("https://") || t.startsWith("http://")) t else "https://$t"
        val scheme = withScheme.substringBefore("://")
        val rest = withScheme.substringAfter("://").substringBefore('/').substringBefore('?').substringBefore('#')
        if (!Regex("^[A-Za-z0-9.-]+(:[0-9]{1,5})?$").matches(rest) || rest.startsWith(".") || rest.startsWith("-")) return null
        if (!rest.contains('.') && !rest.startsWith("localhost")) return null
        return "$scheme://${rest.lowercase()}"
    }
}
