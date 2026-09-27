package sh.vyre.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.runtime.getValue
import sh.vyre.app.data.Markdown
import sh.vyre.app.design.Mono
import sh.vyre.app.design.Radius
import sh.vyre.app.design.Space
import sh.vyre.app.design.Type
import sh.vyre.app.design.V
import sh.vyre.app.design.VyreColors

/**
 * Assistant text drawn from parsed markdown: plain text spans only, never HTML. `style` is the
 * paragraph type (chat messages are Lead, 17/24). `caret` puts the streaming caret (2 x 19,
 * --text, blinking once a second) at the end of the last paragraph while a reply grows.
 */
@Composable
fun Md(text: String, modifier: Modifier = Modifier, style: androidx.compose.ui.text.TextStyle = Type.body, caret: Boolean = false) {
    val c = V.c
    val blocks = remember(text) { Markdown.parse(text) }
    val caretContent = if (caret) mapOf("caret" to androidx.compose.foundation.text.InlineTextContent(
        androidx.compose.ui.text.Placeholder(2.sp, 19.sp, androidx.compose.ui.text.PlaceholderVerticalAlign.TextBottom)) { Caret() }) else emptyMap()
    val lastPara = blocks.indexOfLast { it is Markdown.Block.Para }.takeIf { caret && it == blocks.lastIndex }
    SelectionContainer {
        Column(modifier, verticalArrangement = Arrangement.spacedBy(Space.s)) {
            if (caret && blocks.isEmpty()) Caret(Modifier.size(2.dp, 19.dp))
            for ((n, b) in blocks.withIndex()) when (b) {
                is Markdown.Block.Para -> if (n == lastPara) Text(buildAnnotatedString { append(spans(b.spans, c)); append(" "); appendInlineContent("caret", "|") },
                    style = style, color = c.text, inlineContent = caretContent)
                    else Text(spans(b.spans, c), style = style, color = c.text)
                is Markdown.Block.Heading -> Text(spans(b.spans, c), style = if (b.level <= 2) Type.h3 else Type.bodyStrong, color = c.text)
                is Markdown.Block.Quote -> Text(spans(b.spans, c), style = style, color = c.text2, modifier = Modifier.padding(start = Space.m))
                is Markdown.Block.Bullets -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    for (i in b.items) Row { Text("•", style = style, color = c.label, modifier = Modifier.width(18.dp)); Text(spans(i, c), style = style, color = c.text) }
                }
                is Markdown.Block.Numbered -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    b.items.forEachIndexed { k, i -> Row { Text("${b.start + k}.", style = Type.code, color = c.label, modifier = Modifier.width(28.dp)); Text(spans(i, c), style = style, color = c.text) } }
                }
                is Markdown.Block.Code -> Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.button)).background(c.codeBg)
                    .horizontalScroll(rememberScrollState()).padding(Space.m)) {
                    Text(b.text, style = Type.code, color = c.text, softWrap = false)
                }
            }
        }
    }
}

/** The streaming caret: --text, on for half a second, off for half. */
@Composable
private fun Caret(modifier: Modifier = Modifier.fillMaxSize()) {
    val t = androidx.compose.animation.core.rememberInfiniteTransition(label = "caret")
    val a by t.animateFloat(1f, 0f, androidx.compose.animation.core.infiniteRepeatable(androidx.compose.animation.core.keyframes {
        durationMillis = 1000; 1f at 0; 1f at 499; 0f at 500; 0f at 999 }), label = "blink")
    androidx.compose.foundation.layout.Box(modifier.background(V.c.text.copy(alpha = a)))
}

fun spans(list: List<Markdown.Span>, c: VyreColors): AnnotatedString = buildAnnotatedString {
    for (s in list) when (s) {
        is Markdown.Span.Text -> append(s.text)
        is Markdown.Span.Code -> withStyle(SpanStyle(fontFamily = Mono, background = c.codeBg)) { append(s.text) }
        is Markdown.Span.Bold -> withStyle(SpanStyle(fontWeight = FontWeight(600))) { append(s.text) }
        is Markdown.Span.Italic -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(s.text) }
        // Only http(s) links are ever made; they open in the browser, not in the app.
        is Markdown.Span.Link -> withLink(LinkAnnotation.Url(s.url, TextLinkStyles(SpanStyle(color = c.focus, textDecoration = TextDecoration.Underline)))) { append(s.text) }
    }
}
