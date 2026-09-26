package sh.vyre.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import sh.vyre.app.MainActivity
import sh.vyre.app.design.Mark
import sh.vyre.app.design.V

@Composable
fun Root(activity: MainActivity) {
    Box(Modifier.fillMaxSize().background(V.c.ground), contentAlignment = Alignment.Center) { Mark(48.dp) }
}
