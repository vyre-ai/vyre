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

    @Composable fun Back(color: Color, size: Dp = 20.dp, modifier: Modifier = Modifier) = draw(size, modifier) { u, st ->
        drawPath(Path().apply { moveTo(15f * u, 5f * u); lineTo(8f * u, 12f * u); lineTo(15f * u, 19f * u) }, color, style = st)
    }

    /** Three dots in a row: more. */
    @Composable fun More(color: Color, size: Dp = 22.dp, modifier: Modifier = Modifier) = draw(size, modifier) { u, _ ->
        for (x in listOf(5.5f, 12f, 18.5f)) drawCircle(color, radius = 1.6f * u, center = Offset(x * u, 12f * u))
    }

    @Composable fun Plus(color: Color, size: Dp = 20.dp, modifier: Modifier = Modifier) = draw(size, modifier) { u, st ->
        drawLine(color, Offset(12f * u, 5f * u), Offset(12f * u, 19f * u), strokeWidth = st.width, cap = StrokeCap.Round)
        drawLine(color, Offset(5f * u, 12f * u), Offset(19f * u, 12f * u), strokeWidth = st.width, cap = StrokeCap.Round)
    }

    /** An arrow up: send. */
    @Composable fun Send(color: Color, size: Dp = 20.dp, modifier: Modifier = Modifier) = draw(size, modifier) { u, st ->
        drawLine(color, Offset(12f * u, 19f * u), Offset(12f * u, 5f * u), strokeWidth = st.width * 1.2f, cap = StrokeCap.Round)
        drawPath(Path().apply { moveTo(6f * u, 11f * u); lineTo(12f * u, 5f * u); lineTo(18f * u, 11f * u) }, color, style = Stroke(st.width * 1.2f, cap = StrokeCap.Round, join = StrokeJoin.Round))
    }

    @Composable fun Search(color: Color, size: Dp = 20.dp, modifier: Modifier = Modifier) = draw(size, modifier) { u, st ->
        drawCircle(color, radius = 6.5f * u, center = Offset(10.5f * u, 10.5f * u), style = st)
        drawLine(color, Offset(15.5f * u, 15.5f * u), Offset(20f * u, 20f * u), strokeWidth = st.width, cap = StrokeCap.Round)
    }

    /** A prompt: `>` and an underscore. */
    @Composable fun Terminal(color: Color, size: Dp = 20.dp, modifier: Modifier = Modifier) = draw(size, modifier) { u, st ->
        drawPath(Path().apply { moveTo(5f * u, 7f * u); lineTo(10f * u, 12f * u); lineTo(5f * u, 17f * u) }, color, style = st)
        drawLine(color, Offset(12f * u, 17f * u), Offset(19f * u, 17f * u), strokeWidth = st.width, cap = StrokeCap.Round)
    }

    @Composable fun Eye(color: Color, size: Dp = 20.dp, modifier: Modifier = Modifier) = draw(size, modifier) { u, st ->
        drawPath(Path().apply { moveTo(2.5f * u, 12f * u); quadraticBezierTo(12f * u, 3f * u, 21.5f * u, 12f * u); quadraticBezierTo(12f * u, 21f * u, 2.5f * u, 12f * u); close() }, color, style = st)
        drawCircle(color, radius = 3f * u, center = Offset(12f * u, 12f * u), style = st)
    }

    @Composable fun Pause(color: Color, size: Dp = 20.dp, modifier: Modifier = Modifier) = draw(size, modifier) { u, st ->
        drawLine(color, Offset(9f * u, 6f * u), Offset(9f * u, 18f * u), strokeWidth = st.width * 1.3f, cap = StrokeCap.Round)
        drawLine(color, Offset(15f * u, 6f * u), Offset(15f * u, 18f * u), strokeWidth = st.width * 1.3f, cap = StrokeCap.Round)
    }

    @Composable fun Clock(color: Color, size: Dp = 22.dp, modifier: Modifier = Modifier) = draw(size, modifier) { u, st ->
        drawCircle(color, radius = 8.5f * u, center = Offset(12f * u, 12f * u), style = st)
        drawPath(Path().apply { moveTo(12f * u, 7.5f * u); lineTo(12f * u, 12f * u); lineTo(15f * u, 14f * u) }, color, style = st)
    }

    @Composable fun File(color: Color, size: Dp = 20.dp, modifier: Modifier = Modifier) = draw(size, modifier) { u, st ->
        drawPath(Path().apply { moveTo(6f * u, 3f * u); lineTo(14f * u, 3f * u); lineTo(19f * u, 8f * u); lineTo(19f * u, 21f * u); lineTo(6f * u, 21f * u); close() }, color, style = st)
        drawPath(Path().apply { moveTo(14f * u, 3f * u); lineTo(14f * u, 8f * u); lineTo(19f * u, 8f * u) }, color, style = st)
    }

    /** A speech bubble: a chat. */
    @Composable fun Chat(color: Color, size: Dp = 20.dp, modifier: Modifier = Modifier) = draw(size, modifier) { u, st ->
        drawPath(Path().apply { moveTo(4f * u, 5f * u); lineTo(20f * u, 5f * u); lineTo(20f * u, 16f * u); lineTo(10f * u, 16f * u); lineTo(6f * u, 20f * u); lineTo(6f * u, 16f * u); lineTo(4f * u, 16f * u); close() }, color, style = st)
    }

    /** A circle crossed through: a failure, in --text (never red). */
    @Composable fun Failed(color: Color, size: Dp = 16.dp, modifier: Modifier = Modifier) = draw(size, modifier) { u, st ->
        drawCircle(color, radius = 8.5f * u, center = Offset(12f * u, 12f * u), style = st)
        drawLine(color, Offset(6f * u, 18f * u), Offset(18f * u, 6f * u), strokeWidth = st.width, cap = StrokeCap.Round)
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
