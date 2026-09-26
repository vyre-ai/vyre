package sh.vyre.app.data

/**
 * A small markdown reader of our own for assistant text: paragraphs, headings, bullet and
 * numbered lists, fenced code blocks, and inline code, bold, italic and links. Thread text is
 * untrusted, so it becomes these plain structures and is drawn as text, never as HTML.
 */
object Markdown {
    sealed class Block {
        data class Para(val spans: List<Span>) : Block()
        data class Heading(val level: Int, val spans: List<Span>) : Block()
        data class Bullets(val items: List<List<Span>>) : Block()
        data class Numbered(val start: Int, val items: List<List<Span>>) : Block()
        data class Code(val lang: String?, val text: String) : Block()
        data class Quote(val spans: List<Span>) : Block()
    }

    sealed class Span {
        data class Text(val text: String) : Span()
        data class Code(val text: String) : Span()
        data class Bold(val text: String) : Span()
        data class Italic(val text: String) : Span()
        data class Link(val text: String, val url: String) : Span()
    }

    private val BULLET = Regex("^\\s{0,3}[-*+]\\s+(.*)$")
    private val NUMBER = Regex("^\\s{0,3}(\\d{1,9})[.)]\\s+(.*)$")
    private val HEADING = Regex("^(#{1,6})\\s+(.*?)\\s*#*\\s*$")
    private val FENCE = Regex("^\\s{0,3}(```|~~~)\\s*([A-Za-z0-9_+.-]*)\\s*$")

    fun parse(text: String): List<Block> {
        val out = mutableListOf<Block>()
        val lines = text.replace("\r\n", "\n").split('\n')
        var i = 0
        val para = StringBuilder()
        fun flush() { if (para.isNotBlank()) out += Block.Para(inline(para.toString().trim())); para.setLength(0) }
        while (i < lines.size) {
            val l = lines[i]
            val fence = FENCE.find(l)
            when {
                fence != null -> {
                    flush()
                    val mark = fence.groupValues[1]
                    val body = mutableListOf<String>()
                    i++
                    while (i < lines.size && !lines[i].trimStart().startsWith(mark)) { body += lines[i]; i++ }
                    out += Block.Code(fence.groupValues[2].ifEmpty { null }, body.joinToString("\n"))
                }
                l.isBlank() -> flush()
                HEADING.matches(l) -> { flush(); val m = HEADING.find(l)!!; out += Block.Heading(m.groupValues[1].length, inline(m.groupValues[2])) }
                BULLET.matches(l) -> {
                    flush()
                    val items = mutableListOf<List<Span>>()
                    while (i < lines.size && BULLET.matches(lines[i])) {
                        val sb = StringBuilder(BULLET.find(lines[i])!!.groupValues[1])
                        while (i + 1 < lines.size && lines[i + 1].startsWith("  ") && lines[i + 1].isNotBlank() && !BULLET.matches(lines[i + 1])) { sb.append(' ').append(lines[i + 1].trim()); i++ }
                        items += inline(sb.toString()); i++
                    }
                    out += Block.Bullets(items); continue
                }
                NUMBER.matches(l) -> {
                    flush()
                    val start = NUMBER.find(l)!!.groupValues[1].toInt()
                    val items = mutableListOf<List<Span>>()
                    while (i < lines.size && NUMBER.matches(lines[i])) {
                        val sb = StringBuilder(NUMBER.find(lines[i])!!.groupValues[2])
                        while (i + 1 < lines.size && lines[i + 1].startsWith("  ") && lines[i + 1].isNotBlank() && !NUMBER.matches(lines[i + 1])) { sb.append(' ').append(lines[i + 1].trim()); i++ }
                        items += inline(sb.toString()); i++
                    }
                    out += Block.Numbered(start, items); continue
                }
                l.trimStart().startsWith(">") -> { flush(); out += Block.Quote(inline(l.trimStart().removePrefix(">").trim())) }
                else -> { if (para.isNotEmpty()) para.append(' '); para.append(l.trim()) }
            }
            i++
        }
        flush()
        return out
    }

    private val LINK = Regex("\\[([^\\]]+)]\\((https?://[^\\s)]+)\\)")
    private val BARE = Regex("https?://[^\\s<>()\"']+[^\\s<>()\"'.,;:!?]")

    /** Inline spans: `code` first (nothing inside it is read), then links, **bold**, *italic* and _italic_. */
    fun inline(s: String): List<Span> {
        val out = mutableListOf<Span>()
        var i = 0
        val text = StringBuilder()
        fun flush() { if (text.isNotEmpty()) { out += Span.Text(text.toString()); text.setLength(0) } }
        while (i < s.length) {
            val c = s[i]
            if (c == '`') {
                val end = s.indexOf('`', i + 1)
                if (end > i) { flush(); out += Span.Code(s.substring(i + 1, end)); i = end + 1; continue }
            }
            if (c == '[') {
                val m = LINK.find(s, i)
                if (m != null && m.range.first == i) { flush(); out += Span.Link(m.groupValues[1], m.groupValues[2]); i = m.range.last + 1; continue }
            }
            if (c == 'h' && (s.startsWith("http://", i) || s.startsWith("https://", i))) {
                val m = BARE.find(s, i)
                if (m != null && m.range.first == i) { flush(); out += Span.Link(m.value, m.value); i = m.range.last + 1; continue }
            }
            if (c == '*' && i + 1 < s.length && s[i + 1] == '*') {
                val end = s.indexOf("**", i + 2)
                if (end > i + 2) { flush(); out += Span.Bold(s.substring(i + 2, end)); i = end + 2; continue }
            }
            if ((c == '*' || c == '_') && i + 1 < s.length && s[i + 1] != ' ' && (i == 0 || !s[i - 1].isLetterOrDigit())) {
                val end = s.indexOf(c, i + 1)
                if (end > i + 1 && s[end - 1] != ' ' && (end + 1 >= s.length || !s[end + 1].isLetterOrDigit())) { flush(); out += Span.Italic(s.substring(i + 1, end)); i = end + 1; continue }
            }
            text.append(c); i++
        }
        flush()
        return out
    }
}
