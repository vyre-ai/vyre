package sh.vyre.app.design

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/**
 * docs/design/TOKENS.md, verbatim: each value is named after its CSS token (`--rule-strong` is
 * ruleStrong, `--ink-2` is ink2). No colour here that the tokens do not name, except the three
 * paper washes, which TOKENS.md leaves out: they are the dark washes' alphas over the deep tones.
 */
object Hex {
    val graphite = Color(0xFF0E0D0C)
    val carbon = Color(0xFF161513)
    val raised = Color(0xFF1E1C1A)
    val rule = Color(0xFF2B2926)
    val ruleStrong = Color(0xFF3A3733)
    val ash = Color(0xFF8C877D)
    val stone = Color(0xFFB3AEA4)
    val bone = Color(0xFFF1EEE6)
    val signal = Color(0xFFF1EEE6)
    val signalHover = Color(0xFFFFFFFF)
    val signalInk = Color(0xFF0E0D0C)
    val signalWash = Color(0x1FF1EEE6)
    val recall = Color(0xFFEBC76B)
    val recallWash = Color(0x1AEBC76B)
    /** Attention ("needs you"), violet since 27 Sep 2026. The one place it is set: every beacon role derives from it. */
    val attention = Color(0xFFB8A4FF)

    val paper = Color(0xFFF4F1EA)
    val paperRaised = Color(0xFFFBFAF6)
    val paperRule = Color(0xFFDCD7CC)
    val paperRuleStrong = Color(0xFFC9C3B7)
    val ink = Color(0xFF141311)
    val ink2 = Color(0xFF4A463F)
    val ink3 = Color(0xFF6B665D)
    val signalDeep = Color(0xFF141311)
    val recallDeep = Color(0xFF7E5B0C)
    val attentionPaper = Color(0xFF5B3FC4)
}

/**
 * The colour roles, named as the Deck names them (deck/css/deck.css; docs/design/phone.md
 * section 2), so a phone view and a Deck view read the same variables: `--bg` is bg, `--text-2`
 * is text2, `--beacon-ink` is beaconInk. Values are phone.md's, verbatim; rgba values are written
 * as ARGB with alpha = round(a x 255).
 */
@Immutable
data class VyreColors(
    val dark: Boolean,
    /** --bg: the page ground. */
    val bg: Color,
    /** --panel: cards, sheets, the Capsule. */
    val panel: Color,
    /** --hover: agent tiles, pressed rows, the Deny reveal. */
    val hover: Color,
    /** --rule: hairlines between rows. */
    val rule: Color,
    /** --rule-strong: card and input borders, outline buttons. */
    val ruleStrong: Color,
    /** --text: primary text. */
    val text: Color,
    /** --text-2: secondary text. */
    val text2: Color,
    /** --label: labels, meta, placeholders; the smallest text colour allowed. */
    val label: Color,
    /** --primary-bg / --primary-ink: the one primary button per view. */
    val primaryBg: Color,
    val primaryInk: Color,
    /** --focus: the focus ring, and links. */
    val focus: Color,
    /** --signal-wash: the Ask row in Find, added diff lines, a selected chip. */
    val signalWash: Color,
    /** --match: a search match, the Open session flash. */
    val match: Color,
    /** --beacon-ink / --beacon-dot / --beacon-wash: needs you, nothing else. */
    val beaconInk: Color,
    val beaconDot: Color,
    val beaconWash: Color,
    /** --recall / --recall-wash: came from memory. */
    val recall: Color,
    val recallWash: Color,
    /** --del-wash: deleted diff lines, with --label text. */
    val delWash: Color,
    /** --code-bg: command blocks, the live console. */
    val codeBg: Color,
    /** --mark-wire / --mark-dot: the mark (the dot turns Beacon when something needs you). */
    val markWire: Color,
    val markDot: Color,
    /** --scrim: behind a sheet. */
    val scrim: Color,
)

val DarkColors = VyreColors(
    dark = true, bg = Color(0xFF0E0D0C), panel = Color(0xFF161513), hover = Color(0xFF1E1C1A),
    rule = Color(0xFF2B2926), ruleStrong = Color(0xFF3A3733), text = Color(0xFFF1EEE6), text2 = Color(0xFFB3AEA4),
    label = Color(0xFF8C877D), primaryBg = Color(0xFFF1EEE6), primaryInk = Color(0xFF0E0D0C), focus = Color(0xFFF1EEE6),
    signalWash = Color(0x1FF1EEE6), match = Color(0x33F1EEE6), beaconInk = Hex.attention, beaconDot = Hex.attention,
    beaconWash = Hex.attention.copy(alpha = 0.12f), recall = Color(0xFFEBC76B), recallWash = Color(0x1AEBC76B), delWash = Color(0x248C877D),
    codeBg = Color(0x8C0E0D0C), markWire = Color(0xFFF1EEE6), markDot = Color(0xFFF1EEE6), scrim = Color(0x9E000000),
)

val PaperColors = VyreColors(
    dark = false, bg = Color(0xFFF4F1EA), panel = Color(0xFFFBFAF6), hover = Color(0x0B141311),
    rule = Color(0xFFDCD7CC), ruleStrong = Color(0xFFC9C3B7), text = Color(0xFF141311), text2 = Color(0xFF4A463F),
    label = Color(0xFF6B665D), primaryBg = Color(0xFF141311), primaryInk = Color(0xFFF4F1EA), focus = Color(0xFF141311),
    signalWash = Color(0x1A141311), match = Color(0x29141311), beaconInk = Hex.attentionPaper, beaconDot = Hex.attentionPaper,
    beaconWash = Hex.attentionPaper.copy(alpha = 0.08f), recall = Color(0xFF7E5B0C), recallWash = Color(0x147E5B0C), delWash = Color(0x1A6B665D),
    codeBg = Color(0x0A141311), markWire = Color(0xFF141311), markDot = Color(0xFF141311), scrim = Color(0x57141311),
)

object Space {
    val xs = 4.dp
    val s = 8.dp
    val m = 12.dp
    val l = 16.dp
    val xl = 24.dp
    val xxl = 32.dp
    val xxxl = 48.dp
    /** The page side gutter on a phone (TOKENS.md: 16px phone). */
    val gutter = 16.dp
    /** 48dp touch targets (phone.md asks 44 at least). */
    val target = 48.dp
    /** The shell's header, under the status bar. */
    val header = 48.dp
    /** The floating Capsule's height, and the room pages leave under their last row (56 + 16). */
    val capsule = 56.dp
    val underCapsule = 72.dp
}

/** TOKENS.md shape: --r-1 chips, --r-2 buttons and inputs, --r-3 panels and the Capsule, --r-4 windows. */
object Radius {
    val r0 = 0.dp
    val r1 = 4.dp
    val r2 = 6.dp
    val r3 = 10.dp
    val r4 = 14.dp
    val chip = 4.dp
    val button = 6.dp
    /** A card (phone.md: card 10). */
    val panel = 10.dp
    /** A sheet's top corners. */
    val window = 14.dp
    /** An agent tile at 32 px. */
    val tile = 8.dp
}
