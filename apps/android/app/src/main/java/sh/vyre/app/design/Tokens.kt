package sh.vyre.app.design

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/** docs/design/TOKENS.md, verbatim. No colour here that the tokens do not name. */
object Hex {
    val graphite = Color(0xFF0E0D0C)
    val carbon = Color(0xFF161513)
    val raised = Color(0xFF1E1C1A)
    val rule = Color(0xFF2B2926)
    val ruleStrong = Color(0xFF3A3733)
    val ash = Color(0xFF8C877D)
    val stone = Color(0xFFB3AEA4)
    val bone = Color(0xFFF1EEE6)
    val signal = Color(0xFFC6F36B)
    val signalHover = Color(0xFFD4F88A)
    val signalInk = Color(0xFF0E0D0C)
    val signalWash = Color(0x1FC6F36B)
    val recall = Color(0xFFEBC76B)
    val recallWash = Color(0x1AEBC76B)
    val beacon = Color(0xFFFF7A59)
    val beaconWash = Color(0x1FFF7A59)

    val paper = Color(0xFFF4F1EA)
    val paperRaised = Color(0xFFFBFAF6)
    val paperRule = Color(0xFFDCD7CC)
    val paperRuleStrong = Color(0xFFC9C3B7)
    val ink = Color(0xFF141311)
    val ink2 = Color(0xFF4A463F)
    val ink3 = Color(0xFF6B665D)
    val signalDeep = Color(0xFF46700C)
    val recallDeep = Color(0xFF7E5B0C)
    val beaconDeep = Color(0xFFC2411F)
    val beaconDot = Color(0xFFE5532F)
}

/** The roles a screen asks for. Dark and paper fill them from the tokens. */
@Immutable
data class VyreColors(
    val dark: Boolean,
    val ground: Color,
    val panel: Color,
    val raised: Color,
    val rule: Color,
    val ruleStrong: Color,
    val label: Color,
    val secondary: Color,
    val text: Color,
    /** Focus rings and links. */
    val focus: Color,
    /** The one primary action: its fill and its ink. */
    val primaryFill: Color,
    val primaryInk: Color,
    val signalWash: Color,
    val recall: Color,
    val recallWash: Color,
    val beacon: Color,
    val beaconDot: Color,
    val beaconWash: Color,
    /** The mark's dot. */
    val dot: Color,
    /** Code blocks: carbon on dark, raised paper on light. */
    val code: Color,
)

val DarkColors = VyreColors(
    dark = true, ground = Hex.graphite, panel = Hex.carbon, raised = Hex.raised, rule = Hex.rule,
    ruleStrong = Hex.ruleStrong, label = Hex.ash, secondary = Hex.stone, text = Hex.bone, focus = Hex.signal,
    primaryFill = Hex.signal, primaryInk = Hex.signalInk, signalWash = Hex.signalWash, recall = Hex.recall,
    recallWash = Hex.recallWash, beacon = Hex.beacon, beaconDot = Hex.beacon, beaconWash = Hex.beaconWash,
    dot = Hex.signal, code = Hex.carbon,
)

val PaperColors = VyreColors(
    dark = false, ground = Hex.paper, panel = Hex.paperRaised, raised = Hex.paperRaised, rule = Hex.paperRule,
    ruleStrong = Hex.paperRuleStrong, label = Hex.ink3, secondary = Hex.ink2, text = Hex.ink, focus = Hex.signalDeep,
    // Primary buttons on paper stay ink with paper text (TOKENS.md).
    primaryFill = Hex.ink, primaryInk = Hex.paper, signalWash = Color(0x1F46700C), recall = Hex.recallDeep,
    recallWash = Color(0x1A7E5B0C), beacon = Hex.beaconDeep, beaconDot = Hex.beaconDot, beaconWash = Color(0x1FE5532F),
    dot = Hex.ink, code = Hex.paperRaised,
)

object Space {
    val xs = 4.dp
    val s = 8.dp
    val m = 12.dp
    val l = 16.dp
    val xl = 24.dp
    val xxl = 32.dp
    val gutter = 16.dp
    /** 48dp touch targets. */
    val target = 48.dp
}

object Radius {
    val chip = 4.dp
    val button = 6.dp
    val panel = 10.dp
    val window = 14.dp
}
