package sh.vyre.app.data

/** "now", "6 min", "2 h", "3 d": how long ago, in the boards' short form. */
fun ago(at: Long?, now: Long = System.currentTimeMillis()): String {
    if (at == null || at <= 0) return ""
    val s = ((now - at) / 1000).coerceAtLeast(0)
    return when {
        s < 60 -> "now"
        s < 3600 -> "${s / 60} min"
        s < 86400 -> "${s / 3600} h"
        else -> "${s / 86400} d"
    }
}

fun bytes(n: Long?): String {
    if (n == null) return ""
    return when {
        n < 1024 -> "$n B"
        n < 1024 * 1024 -> "${n / 1024} KB"
        n < 1024L * 1024 * 1024 -> String.format("%.1f MB", n / 1048576.0)
        else -> String.format("%.1f GB", n / 1073741824.0)
    }
}

fun money(usd: Double?): String = if (usd == null) "" else if (usd < 0.01) "under 1 cent" else String.format("$%.2f", usd)

/**
 * The avatar's letters: the first letters of the owner's first and last words (system.info
 * `owner.name`, "Alex Rivera" is AR), or the box host's first letter when the box has no name.
 */
fun initials(owner: String?, host: String?): String {
    val words = owner?.trim()?.split(Regex("\\s+"))?.filter { w -> w.firstOrNull()?.isLetterOrDigit() == true }.orEmpty()
    if (words.isNotEmpty()) return (words.first().take(1) + (if (words.size > 1) words.last().take(1) else "")).uppercase()
    return host?.trim()?.firstOrNull { it.isLetterOrDigit() }?.uppercase() ?: "V"
}
