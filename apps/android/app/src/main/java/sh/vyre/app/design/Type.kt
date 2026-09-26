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

/** The type roles in docs/design/TOKENS.md (H1 44/48, H2 28/34, H3 20/26, Body 15/22, Small 13/18, Label and Code in mono), as the PWA sets them on a phone. Sizes are sp so they follow the system font scale. */
object Type {
    // ---- phone.md section 2, the phone's roles (sentence case; mono only for commands, code, logs) ----
    /** The page labels in the header (Now, Chats, Agents). */
    val page = TextStyle(fontFamily = Sans, fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight(600), letterSpacing = (-0.015).em)
    /** The detail sheet's title. */
    val sheetTitle = TextStyle(fontFamily = Sans, fontSize = 26.sp, lineHeight = 32.sp, fontWeight = FontWeight(600), letterSpacing = (-0.015).em)
    /** Section headers on Now. */
    val section = TextStyle(fontFamily = Sans, fontSize = 20.sp, lineHeight = 25.sp, fontWeight = FontWeight(600))
    /** Group headers in Find and Agents; the chat nav title; agent names. */
    val group = TextStyle(fontFamily = Sans, fontSize = 17.sp, lineHeight = 22.sp, fontWeight = FontWeight(600))
    /** Rows in cards. */
    val rowTitle = TextStyle(fontFamily = Sans, fontSize = 16.sp, lineHeight = 21.sp, fontWeight = FontWeight(600))
    /** Chat messages, a question's text. */
    val lead = TextStyle(fontFamily = Sans, fontSize = 17.sp, lineHeight = 24.sp, fontWeight = FontWeight(400))
    /** Search and composer text (never under 16). */
    val input = TextStyle(fontFamily = Sans, fontSize = 17.sp, lineHeight = 22.sp, fontWeight = FontWeight(400))
    /** Row second lines, fact rows. */
    val secondary = TextStyle(fontFamily = Sans, fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight(400))
    /** "kit · Harlow Legal", times, hints. */
    val meta = TextStyle(fontFamily = Sans, fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight(400))
    /** Chat nav subtitle, tags. */
    val micro = TextStyle(fontFamily = Sans, fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight(400))
    /** Every button label, sentence case (the phone's one departure from TOKENS.md). */
    val button = TextStyle(fontFamily = Sans, fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight(600))
    /** The 54 tall primary's label. */
    val buttonLarge = TextStyle(fontFamily = Sans, fontSize = 17.sp, lineHeight = 22.sp, fontWeight = FontWeight(600))
    /** Commands in blocks; [commandRow] in rows. */
    val command = TextStyle(fontFamily = Mono, fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight(400))
    val commandRow = TextStyle(fontFamily = Mono, fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight(400))
    /** Live console, diffs; [logRow] in tool rows. */
    val log = TextStyle(fontFamily = Mono, fontSize = 12.sp, lineHeight = 19.sp, fontWeight = FontWeight(400))
    val logRow = TextStyle(fontFamily = Mono, fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight(400))

    // ---- shared with the Deck (TOKENS.md); screens not yet redrawn for the phone still use these ----
    val h1 = TextStyle(fontFamily = Sans, fontSize = 44.sp, lineHeight = 48.sp, fontWeight = FontWeight(600), letterSpacing = (-0.03).em)
    val h2 = TextStyle(fontFamily = Sans, fontSize = 28.sp, lineHeight = 34.sp, fontWeight = FontWeight(600), letterSpacing = (-0.02).em)
    val h3 = TextStyle(fontFamily = Sans, fontSize = 20.sp, lineHeight = 26.sp, fontWeight = FontWeight(600), letterSpacing = (-0.01).em)
    /** Chat messages (phone.md Body 16/23). */
    val body = TextStyle(fontFamily = Sans, fontSize = 16.sp, lineHeight = 23.sp, fontWeight = FontWeight(400))
    val bodyStrong = body.copy(fontWeight = FontWeight(500))
    val small = TextStyle(fontFamily = Sans, fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight(400))
    /** Engraved label: mono 11, uppercase, +0.16em. Callers uppercase the text. */
    val label = TextStyle(fontFamily = Mono, fontSize = 11.sp, lineHeight = 14.sp, fontWeight = FontWeight(500), letterSpacing = 0.16.em)
    val code = TextStyle(fontFamily = Mono, fontSize = 13.sp, lineHeight = 20.sp, fontWeight = FontWeight(400))
    val monoSmall = TextStyle(fontFamily = Mono, fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight(400))
    val hero = TextStyle(fontFamily = Mono, fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight(500), letterSpacing = (-0.01).em)
}
