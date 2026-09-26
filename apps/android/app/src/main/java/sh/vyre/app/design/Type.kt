package sh.vyre.app.design

import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import sh.vyre.app.R

@OptIn(ExperimentalTextApi::class)
private fun sans(w: Int) = Font(R.font.instrument_sans, FontWeight(w), variationSettings = FontVariation.Settings(FontVariation.weight(w)))

@OptIn(ExperimentalTextApi::class)
private fun mono(w: Int) = Font(R.font.jetbrains_mono, FontWeight(w), variationSettings = FontVariation.Settings(FontVariation.weight(w)))

/** Instrument Sans 400/500/600 and JetBrains Mono 400/500, bundled (both OFL). */
val Sans = FontFamily(sans(400), sans(500), sans(600))
val Mono = FontFamily(mono(400), mono(500))

/** The type roles in TOKENS.md. Sizes are sp so they follow the system font scale. */
object Type {
    val h1 = TextStyle(fontFamily = Sans, fontSize = 30.sp, lineHeight = 36.sp, fontWeight = FontWeight(600), letterSpacing = (-0.03).em)
    val h2 = TextStyle(fontFamily = Sans, fontSize = 24.sp, lineHeight = 30.sp, fontWeight = FontWeight(600), letterSpacing = (-0.02).em)
    val h3 = TextStyle(fontFamily = Sans, fontSize = 18.sp, lineHeight = 24.sp, fontWeight = FontWeight(600), letterSpacing = (-0.01).em)
    val body = TextStyle(fontFamily = Sans, fontSize = 15.sp, lineHeight = 22.sp, fontWeight = FontWeight(400))
    val bodyStrong = body.copy(fontWeight = FontWeight(500))
    val small = TextStyle(fontFamily = Sans, fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight(400))
    /** Engraved label: mono 11, uppercase, +0.16em. Callers uppercase the text. */
    val label = TextStyle(fontFamily = Mono, fontSize = 11.sp, lineHeight = 14.sp, fontWeight = FontWeight(500), letterSpacing = 0.16.em)
    val button = TextStyle(fontFamily = Mono, fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight(500), letterSpacing = 0.12.em)
    val code = TextStyle(fontFamily = Mono, fontSize = 13.sp, lineHeight = 20.sp, fontWeight = FontWeight(400))
    val monoSmall = TextStyle(fontFamily = Mono, fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight(400))
    val hero = TextStyle(fontFamily = Mono, fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight(500), letterSpacing = (-0.01).em)
}
