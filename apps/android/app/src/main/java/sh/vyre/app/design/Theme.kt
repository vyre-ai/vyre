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

enum class ThemeChoice { System, Dark, Paper }

/** Dark by default and paper when the system is light, unless Settings picks one. */
@Composable
fun VyreTheme(choice: ThemeChoice = ThemeChoice.System, content: @Composable () -> Unit) {
    val dark = when (choice) {
        ThemeChoice.System -> isSystemInDarkTheme()
        ThemeChoice.Dark -> true
        ThemeChoice.Paper -> false
    }
    val c = if (dark) DarkColors else PaperColors
    val scheme = if (dark) darkColorScheme(
        primary = c.primaryFill, onPrimary = c.primaryInk, background = c.ground, onBackground = c.text,
        surface = c.ground, onSurface = c.text, surfaceVariant = c.panel, onSurfaceVariant = c.secondary,
        surfaceContainer = c.panel, surfaceContainerHigh = c.raised, surfaceContainerLow = c.panel,
        outline = c.ruleStrong, outlineVariant = c.rule, error = c.beacon, secondary = c.secondary,
    ) else lightColorScheme(
        primary = c.primaryFill, onPrimary = c.primaryInk, background = c.ground, onBackground = c.text,
        surface = c.ground, onSurface = c.text, surfaceVariant = c.panel, onSurfaceVariant = c.secondary,
        surfaceContainer = c.panel, surfaceContainerHigh = c.raised, surfaceContainerLow = c.panel,
        outline = c.ruleStrong, outlineVariant = c.rule, error = c.beacon, secondary = c.secondary,
    )
    CompositionLocalProvider(LocalVyre provides c) {
        MaterialTheme(colorScheme = scheme, typography = MaterialTheme.typography.let {
            it.copy(bodyLarge = Type.body, bodyMedium = Type.body, bodySmall = Type.small, labelLarge = Type.button,
                titleLarge = Type.h3, titleMedium = Type.bodyStrong, labelSmall = Type.label, labelMedium = Type.label)
        }, content = content)
    }
}
