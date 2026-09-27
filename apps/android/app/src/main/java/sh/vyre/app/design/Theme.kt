package sh.vyre.app.design

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf

val LocalVyre = staticCompositionLocalOf { DarkColors }

/** The palette of the screen being drawn. */
object V {
    val c: VyreColors @Composable get() = LocalVyre.current
}

/** Dark (Graphite), Paper, and System, the default, which follows the phone (phone.md section 2). */
enum class ThemeChoice(val label: String) { Dark("Dark"), Paper("Paper"), System("System") }

/** The theme follows the phone (phone.md section 2), unless Settings picks Dark or Paper. */
@Composable
fun VyreTheme(choice: ThemeChoice = ThemeChoice.System, content: @Composable () -> Unit) {
    val dark = when (choice) {
        ThemeChoice.System -> isSystemInDarkTheme()
        ThemeChoice.Dark -> true
        ThemeChoice.Paper -> false
    }
    val c = if (dark) DarkColors else PaperColors
    val scheme = if (dark) darkColorScheme(
        primary = c.primaryBg, onPrimary = c.primaryInk, background = c.bg, onBackground = c.text,
        surface = c.bg, onSurface = c.text, surfaceVariant = c.panel, onSurfaceVariant = c.text2,
        surfaceContainer = c.panel, surfaceContainerHigh = c.hover, surfaceContainerLow = c.panel,
        outline = c.ruleStrong, outlineVariant = c.rule, error = c.beaconInk, secondary = c.text2,
    ) else lightColorScheme(
        primary = c.primaryBg, onPrimary = c.primaryInk, background = c.bg, onBackground = c.text,
        surface = c.bg, onSurface = c.text, surfaceVariant = c.panel, onSurfaceVariant = c.text2,
        surfaceContainer = c.panel, surfaceContainerHigh = c.hover, surfaceContainerLow = c.panel,
        outline = c.ruleStrong, outlineVariant = c.rule, error = c.beaconInk, secondary = c.text2,
    )
    CompositionLocalProvider(LocalVyre provides c) {
        MaterialTheme(colorScheme = scheme, typography = MaterialTheme.typography.let {
            it.copy(bodyLarge = Type.body, bodyMedium = Type.body, bodySmall = Type.small, labelLarge = Type.button,
                titleLarge = Type.h3, titleMedium = Type.bodyStrong, labelSmall = Type.label, labelMedium = Type.label)
        }, content = content)
    }
}
