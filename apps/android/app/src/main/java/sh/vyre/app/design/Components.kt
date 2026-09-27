package sh.vyre.app.design

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** Engraved label: mono 11 uppercase +0.16em, ash unless it names a role (Beacon, Recall). */
@Composable
fun Label(text: String, modifier: Modifier = Modifier, color: Color = V.c.label) {
    Text(text.uppercase(), modifier = modifier.semantics { heading() }, style = Type.label, color = color, maxLines = 1, overflow = TextOverflow.Ellipsis)
}

/** A row of two engraved labels, left and right, above a section. */
@Composable
fun SectionHead(left: String, right: String? = null, color: Color = V.c.label, rightColor: Color = V.c.label, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().padding(top = Space.xl, bottom = Space.s), verticalAlignment = Alignment.CenterVertically) {
        Label(left, Modifier.weight(1f), color)
        if (right != null) Label(right, color = rightColor)
    }
}

@Composable
fun Hairline(modifier: Modifier = Modifier, strong: Boolean = false) {
    Box(modifier.fillMaxWidth().height(1.dp).background(if (strong) V.c.ruleStrong else V.c.rule))
}

/** The Deck's three kinds, and no others: no red, no attention fill, no error role. */
enum class ButtonKind { Primary, Secondary, Ghost }

/**
 * A button (phone.md section 2): sentence-case sans 15/600, 44 tall with radius 10, or taller
 * (46 and 54, radius 12; 17/600 at 54) in a sheet. Primary is --primary-bg with --primary-ink, one
 * per view; Secondary is --text on --hover with a --rule-strong border; Ghost is text only, full
 * --text at 600, never --text-2.
 */
@Composable
fun VButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, kind: ButtonKind = ButtonKind.Secondary, enabled: Boolean = true,
            leading: String? = null, height: Dp = 44.dp, icon: (@Composable (Color) -> Unit)? = null) {
    val c = V.c
    val tall = height >= 46.dp
    val shape = RoundedCornerShape(if (tall) 12.dp else 10.dp)
    val (fill, ink, border) = when (kind) {
        ButtonKind.Primary -> Triple(c.primaryBg, c.primaryInk, Color.Transparent)
        ButtonKind.Secondary -> Triple(c.hover, c.text, c.ruleStrong)
        ButtonKind.Ghost -> Triple(Color.Transparent, c.text, Color.Transparent)
    }
    val tint = if (enabled) ink else c.label
    Row(
        modifier.heightIn(min = height).widthIn(min = 64.dp).clip(shape).background(if (enabled) fill else if (kind == ButtonKind.Ghost) Color.Transparent else c.hover)
            .border(1.dp, if (enabled) border else if (kind == ButtonKind.Secondary) c.rule else Color.Transparent, shape)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick).padding(horizontal = Space.l),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center,
    ) {
        if (icon != null) { icon(tint); androidx.compose.foundation.layout.Spacer(Modifier.size(8.dp)) }
        Text((if (leading != null) "$leading  " else "") + text, style = if (height >= 54.dp) Type.buttonLarge else Type.button, color = tint, textAlign = TextAlign.Center, maxLines = 1)
    }
}

/**
 * A failure, as a fact and not an alarm (phone.md section 11): a crossed circle, a `failed` label
 * in --label, and the reason in --text. Never red.
 */
@Composable
fun Failure(reason: String, modifier: Modifier = Modifier) {
    val c = V.c
    Row(modifier.semantics(mergeDescendants = true) {}, verticalAlignment = Alignment.Top) {
        Glyph.Failed(c.text, 16.dp, Modifier.padding(top = 1.dp))
        androidx.compose.foundation.layout.Spacer(Modifier.size(6.dp))
        Text("failed", style = Type.meta, color = c.label)
        androidx.compose.foundation.layout.Spacer(Modifier.size(6.dp))
        Text(reason, style = Type.meta, color = c.text)
    }
}

/** The Lead mark, drawn from its 24 grid: one wire bent into a v, the dot leaving its end. */
@Composable
fun Mark(size: Dp = 24.dp, wire: Color = V.c.text, dot: Color = V.c.markDot, modifier: Modifier = Modifier) {
    Canvas(modifier.size(size)) {
        val u = this.size.width / 24f
        val p = Path().apply { moveTo(3.5f * u, 5.5f * u); lineTo(12f * u, 19.5f * u); lineTo(17.96f * u, 9.69f * u) }
        drawPath(p, wire, style = Stroke(width = 2.4f * u, cap = StrokeCap.Round, join = StrokeJoin.Round))
        drawCircle(dot, radius = 2.3f * u, center = Offset(20.5f * u, 5.5f * u))
    }
}

/** The monoline wordmark "vyre", drawn in the mark's wire. Ratio 62:26. */
@Composable
fun Wordmark(height: Dp = 22.dp, color: Color = V.c.text, modifier: Modifier = Modifier) {
    Canvas(modifier.size(width = height * (62f / 26f), height = height)) {
        val u = this.size.height / 26f
        fun x(v: Float) = (v + 2f) * u
        fun y(v: Float) = (v - 3f) * u
        val st = Stroke(width = 2.6f * u, cap = StrokeCap.Round, join = StrokeJoin.Round)
        val p = Path().apply {
            moveTo(x(0f), y(6f)); lineTo(x(6f), y(20f)); lineTo(x(12f), y(6f))
            moveTo(x(16f), y(6f)); lineTo(x(22f), y(20f))
            moveTo(x(28f), y(6f)); lineTo(x(19.4f), y(26f))
            moveTo(x(33f), y(6f)); lineTo(x(33f), y(20f))
            moveTo(x(33f), y(13f)); quadraticBezierTo(x(33f), y(6f), x(40f), y(6f))
            moveTo(x(43f), y(13f)); lineTo(x(57f), y(13f))
            // A 7 7 0 1 0 55.36 17.5: the e's bowl, from (57,13) round to (55.36,17.5).
            arcTo(androidx.compose.ui.geometry.Rect(x(43f), y(6f), x(57f), y(20f)), 0f, -320f, false)
        }
        drawPath(p, color, style = st)
    }
}

/** A small filled dot, Beacon for needs-you, red-free elsewhere. */
@Composable
fun Dot(color: Color, size: Dp = 6.dp, modifier: Modifier = Modifier) {
    Box(modifier.size(size).clip(RoundedCornerShape(50)).background(color))
}

/** A filter chip (phone.md: 30 tall, radius 8, 13/600): selected is --text fill with --bg words, the others an outline. */
@Composable
fun Chip(text: String, onClick: () -> Unit, selected: Boolean = false, modifier: Modifier = Modifier) {
    val c = V.c
    val shape = RoundedCornerShape(8.dp)
    Box(modifier.heightIn(min = 44.dp).clickable(role = Role.Button, onClick = onClick), contentAlignment = Alignment.Center) {
        Box(Modifier.heightIn(min = 30.dp).clip(shape).background(if (selected) c.text else Color.Transparent)
            .border(1.dp, if (selected) c.text else c.ruleStrong, shape).padding(horizontal = Space.m, vertical = 5.dp), contentAlignment = Alignment.Center) {
            Text(text, style = Type.meta.copy(fontWeight = androidx.compose.ui.text.font.FontWeight(600)), color = if (selected) c.bg else c.text2, maxLines = 1)
        }
    }
}
