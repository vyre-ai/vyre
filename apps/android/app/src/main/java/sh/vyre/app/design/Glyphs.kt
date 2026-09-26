package sh.vyre.app.design

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * The phone's stroke icons (phone.md section 2): a 24 grid, 1.5 stroke (1.7 at 26 and above),
 * round caps and joins, one colour. Drawn here so no icon font or image is bundled.
 */
object Glyph {
    @Composable fun Fingerprint(color: Color, size: Dp = 24.dp, modifier: Modifier = Modifier) = draw(size, modifier) { u, st ->
        // Three nested arcs and a centre line: the fingerprint, as Android draws it, simplified.
        for ((i, r) in listOf(9f, 6.5f, 4f).withIndex()) {
            val sweep = if (i == 0) 220f else 260f
            drawArc(color, 180f - (sweep - 180f) / 2f, sweep, false, topLeft = Offset((12f - r) * u, (12.5f - r) * u), size = Size(2 * r * u, 2 * r * u), style = st)
        }
        drawLine(color, Offset(12f * u, 11f * u), Offset(12f * u, 17f * u), strokeWidth = st.width, cap = StrokeCap.Round)
    }

    @Composable fun Close(color: Color, size: Dp = 16.dp, modifier: Modifier = Modifier) = draw(size, modifier) { u, st ->
        drawLine(color, Offset(6f * u, 6f * u), Offset(18f * u, 18f * u), strokeWidth = st.width, cap = StrokeCap.Round)
        drawLine(color, Offset(18f * u, 6f * u), Offset(6f * u, 18f * u), strokeWidth = st.width, cap = StrokeCap.Round)
    }

    @Composable fun Chevron(color: Color, size: Dp = 16.dp, modifier: Modifier = Modifier) = draw(size, modifier) { u, st ->
        drawPath(Path().apply { moveTo(9f * u, 5f * u); lineTo(16f * u, 12f * u); lineTo(9f * u, 19f * u) }, color, style = st)
    }

    /** A clock with a turned-back arrow: "from memory". */
    @Composable fun History(color: Color, size: Dp = 14.dp, modifier: Modifier = Modifier) = draw(size, modifier) { u, st ->
        drawArc(color, 200f, 300f, false, topLeft = Offset(4f * u, 4f * u), size = Size(16f * u, 16f * u), style = st)
        drawPath(Path().apply { moveTo(3.5f * u, 6f * u); lineTo(4.6f * u, 9.6f * u); lineTo(8f * u, 8.5f * u) }, color, style = st)
        drawPath(Path().apply { moveTo(12f * u, 8f * u); lineTo(12f * u, 12f * u); lineTo(15f * u, 14f * u) }, color, style = st)
    }

    @Composable fun Check(color: Color, size: Dp = 16.dp, modifier: Modifier = Modifier) = draw(size, modifier) { u, st ->
        drawPath(Path().apply { moveTo(5f * u, 12.5f * u); lineTo(10f * u, 17f * u); lineTo(19f * u, 7f * u) }, color, style = st)
    }

    @Composable
    private fun draw(size: Dp, modifier: Modifier, block: DrawScope.(u: Float, st: Stroke) -> Unit) {
        Canvas(modifier.size(size)) {
            val u = this.size.width / 24f
            val w = (if (size >= 26.dp) 1.7f else 1.5f) * u
            block(u, Stroke(width = w, cap = StrokeCap.Round, join = StrokeJoin.Round))
        }
    }
}
