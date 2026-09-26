package sh.vyre.app.ui

import android.view.HapticFeedbackConstants
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import sh.vyre.app.MainActivity
import sh.vyre.app.VyreApp
import sh.vyre.app.api.ApiError
import sh.vyre.app.api.plain
import sh.vyre.app.api.str
import sh.vyre.app.design.Hairline
import sh.vyre.app.design.Label
import sh.vyre.app.design.Mark
import sh.vyre.app.design.Space
import sh.vyre.app.design.Type
import sh.vyre.app.design.V
import sh.vyre.app.design.Wordmark

val LocalApp = staticCompositionLocalOf<VyreApp> { error("no app") }
val LocalActivity = staticCompositionLocalOf<MainActivity> { error("no activity") }
/** Navigate to a route string ("thread/<id>", "needs/<id>", ...). */
val LocalNav = staticCompositionLocalOf<(String) -> Unit> { {} }

/** A read from the box: loading, its value, or what went wrong. */
class Load<T>(val value: T?, val error: Throwable?, val loading: Boolean)

class Loader<T>(private val state: MutableState<Load<T>>, private val scope: CoroutineScope, private val fetch: suspend () -> T) {
    val v: Load<T> get() = state.value
    fun refresh(quiet: Boolean = true) {
        if (!quiet) state.value = Load(state.value.value, null, true)
        scope.launch {
            state.value = try { Load(fetch(), null, false) } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                Load(state.value.value, e, false)
            }
        }
    }
}

/** Load once when shown (and when `key` changes); refresh() re-reads. */
@Composable
fun <T> rememberLoad(vararg keys: Any?, fetch: suspend () -> T): Loader<T> {
    val scope = rememberCoroutineScope()
    val state = remember(*keys) { mutableStateOf(Load<T>(null, null, true)) }
    val f by rememberUpdatedState(fetch)
    val loader = remember(*keys) { Loader(state, scope) { f() } }
    LaunchedEffect(*keys) { loader.refresh(quiet = false) }
    return loader
}

/** Run `block` for each live event whose type is in `types` (or starts with a `x.*` prefix). */
@Composable
fun OnEvents(vararg types: String, block: suspend (JsonObject) -> Unit) {
    val app = LocalApp.current
    val b by rememberUpdatedState(block)
    LaunchedEffect(types.joinToString()) {
        app.stream.events.collect { e ->
            val t = e.str("type") ?: return@collect
            if (types.any { if (it.endsWith(".*")) t.startsWith(it.dropLast(1)) else it == t }) b(e)
        }
    }
}

/** The top of a tab: the mark and wordmark, the box's name at the right (PhoneNow board). */
@Composable
fun BrandBar(right: String? = null) {
    Row(Modifier.fillMaxWidth().padding(top = Space.l, bottom = Space.s), verticalAlignment = Alignment.CenterVertically) {
        Mark(20.dp)
        Spacer(Modifier.width(6.dp))
        Wordmark(20.dp)
        Spacer(Modifier.weight(1f))
        if (right != null) Text(right, style = Type.monoSmall, color = V.c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** A pushed screen's top: back and a title, a label at the right. */
@Composable
fun BackBar(title: String, onBack: () -> Unit, right: (@Composable () -> Unit)? = null) {
    Row(Modifier.fillMaxWidth().heightIn(min = Space.target), verticalAlignment = Alignment.CenterVertically) {
        Row(Modifier.heightIn(min = Space.target).clickable(role = Role.Button, onClick = onBack).semantics { contentDescription = "Back to $title" }, verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, null, tint = V.c.text, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(Space.s))
            Text(title, style = Type.body, color = V.c.text)
        }
        Spacer(Modifier.weight(1f))
        right?.invoke()
    }
}

/**
 * The page: side gutter 16, pull to refresh, a list. Everything is on the ground; sections are
 * separated by rules and labels, not boxes.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun Page(refreshing: Boolean = false, onRefresh: (() -> Unit)? = null, top: @Composable ColumnScope.() -> Unit = {}, content: LazyListScope.() -> Unit) {
    Column(Modifier.fillMaxSize().background(V.c.ground).statusBarsPadding()) {
        Column(Modifier.padding(horizontal = Space.gutter), content = top)
        val list: @Composable () -> Unit = {
            LazyColumn(Modifier.fillMaxSize(), state = rememberLazyListState(), contentPadding = PaddingValues(start = Space.gutter, end = Space.gutter, bottom = Space.xxl), content = content)
        }
        if (onRefresh != null) PullToRefreshBox(isRefreshing = refreshing, onRefresh = onRefresh, modifier = Modifier.fillMaxSize()) { list() } else list()
    }
}

/** A list row: a title, a mono line under it, a chevron. 56dp tall at least, a rule below. */
@Composable
fun Row2(title: String, sub: String? = null, onClick: (() -> Unit)? = null, leading: (@Composable () -> Unit)? = null, trailing: (@Composable () -> Unit)? = null, subColor: androidx.compose.ui.graphics.Color? = null) {
    Column {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 56.dp).then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier).padding(vertical = Space.s),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (leading != null) { leading(); Spacer(Modifier.width(Space.m)) }
            Column(Modifier.weight(1f)) {
                Text(title, style = Type.body, color = V.c.text, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (!sub.isNullOrEmpty()) Text(sub, style = Type.monoSmall, color = subColor ?: V.c.secondary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (trailing != null) trailing()
            else if (onClick != null) Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, tint = V.c.label, modifier = Modifier.size(18.dp))
        }
        Hairline()
    }
}

/** A quiet line for empty and failed states. Errors are Bone text with an Ash label, not red. */
@Composable
fun Quiet(text: String, label: String? = null) {
    Column(Modifier.fillMaxWidth().padding(vertical = Space.l), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (label != null) Label(label)
        Text(text, style = Type.small, color = V.c.secondary)
    }
}

fun LazyListScope.loadState(l: Load<*>, empty: Boolean, emptyText: String) {
    val e = l.error
    if (e != null && l.value == null) item { Quiet(e.plain(), if (e is ApiError.Offline) "offline" else "failed") }
    else if (l.value == null && l.loading) item { Quiet("Loading") }
    else if (empty) item { Quiet(emptyText) }
}

/** The approve haptic: a confirm tick. */
@Composable
fun rememberHaptic(): () -> Unit {
    val view = LocalView.current
    return { view.performHapticFeedback(if (android.os.Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.LONG_PRESS) }
}

/** A counter that ticks each second while shown, for countdowns. */
@Composable
fun rememberTick(periodMs: Long = 1000): Int {
    var n by remember { mutableIntStateOf(0) }
    LaunchedEffect(periodMs) { while (true) { kotlinx.coroutines.delay(periodMs); n++ } }
    return n
}

@Composable
fun Gap(h: androidx.compose.ui.unit.Dp) = Box(Modifier.size(1.dp, h))
