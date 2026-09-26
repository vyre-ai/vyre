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
import sh.vyre.app.data.Markdown
import sh.vyre.app.design.Mono
import sh.vyre.app.design.Radius
import sh.vyre.app.design.Space
import sh.vyre.app.design.Type
import sh.vyre.app.design.V
import sh.vyre.app.design.VyreColors

/** Assistant text drawn from parsed markdown: plain text spans only, never HTML. */
@Composable
fun Md(text: String, modifier: Modifier = Modifier) {
    val c = V.c
    val blocks = remember(text) { Markdown.parse(text) }
    SelectionContainer {
        Column(modifier, verticalArrangement = Arrangement.spacedBy(Space.s)) {
            for (b in blocks) when (b) {
                is Markdown.Block.Para -> Text(spans(b.spans, c), style = Type.body, color = c.text)
                is Markdown.Block.Heading -> Text(spans(b.spans, c), style = if (b.level <= 2) Type.h3 else Type.bodyStrong, color = c.text)
                is Markdown.Block.Quote -> Text(spans(b.spans, c), style = Type.body, color = c.secondary, modifier = Modifier.padding(start = Space.m))
                is Markdown.Block.Bullets -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    for (i in b.items) Row { Text("•", style = Type.body, color = c.label, modifier = Modifier.width(18.dp)); Text(spans(i, c), style = Type.body, color = c.text) }
                }
                is Markdown.Block.Numbered -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    b.items.forEachIndexed { n, i -> Row { Text("${b.start + n}.", style = Type.code, color = c.label, modifier = Modifier.width(28.dp)); Text(spans(i, c), style = Type.body, color = c.text) } }
                }
                is Markdown.Block.Code -> Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.button)).background(if (c.dark) c.code else c.raised)
                    .horizontalScroll(rememberScrollState()).padding(Space.m)) {
                    Text(b.text, style = Type.code, color = c.text, softWrap = false)
                }
            }
        }
    }
}

fun spans(list: List<Markdown.Span>, c: VyreColors): AnnotatedString = buildAnnotatedString {
    for (s in list) when (s) {
        is Markdown.Span.Text -> append(s.text)
        is Markdown.Span.Code -> withStyle(SpanStyle(fontFamily = Mono, background = if (c.dark) c.code else c.raised)) { append(s.text) }
        is Markdown.Span.Bold -> withStyle(SpanStyle(fontWeight = FontWeight(600))) { append(s.text) }
        is Markdown.Span.Italic -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(s.text) }
        // Only http(s) links are ever made; they open in the browser, not in the app.
        is Markdown.Span.Link -> withLink(LinkAnnotation.Url(s.url, TextLinkStyles(SpanStyle(color = c.focus, textDecoration = TextDecoration.Underline)))) { append(s.text) }
    }
}
