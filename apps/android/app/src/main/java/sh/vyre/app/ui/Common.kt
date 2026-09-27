package sh.vyre.app.ui

import android.view.HapticFeedbackConstants
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
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
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
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
import androidx.compose.ui.draw.clip
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
/** True inside the shell's pages and sheets: the header or the sheet owns the top inset, and pages leave room for the Capsule. */
val LocalInShell = staticCompositionLocalOf { false }
/** True while this page is the one on screen (the pager settled on it, nothing pushed over it). */
val LocalOnScreen = staticCompositionLocalOf { true }
/** Show a short line over the Capsule (an Undo, a note). */
val LocalToast = staticCompositionLocalOf<(Toast) -> Unit> { {} }
/** Open a route on the tab it belongs to (a session on Chat from Now's "Open session"), as a link would. */
val LocalGo = staticCompositionLocalOf<(String) -> Unit> { {} }
/** The assistant's name (system.info assistant.name; "Vyre" when there is none), for labels and placeholders. */
val LocalAssistant = androidx.compose.runtime.compositionLocalOf { sh.vyre.app.data.Speaker.FALLBACK }

/** A grouped card (phone.md section 4): --panel, a --rule border, radius 10. Rows inside draw their own hairlines. */
@Composable
fun Grouped(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val c = V.c
    val shape = androidx.compose.foundation.shape.RoundedCornerShape(sh.vyre.app.design.Radius.panel)
    Column(modifier.fillMaxWidth().clip(shape).background(c.panel).border(1.dp, c.rule, shape), content = content)
}

/** A 32 (or 24, 40) agent tile: --hover, a --rule-strong border, the agent's initial. */
@Composable
fun Tile(name: String?, size: androidx.compose.ui.unit.Dp = 32.dp) {
    val c = V.c
    val r = if (size >= 40.dp) 11.dp else if (size >= 32.dp) 8.dp else 6.dp
    val shape = androidx.compose.foundation.shape.RoundedCornerShape(r)
    Box(Modifier.size(size).clip(shape).background(c.hover).border(1.dp, c.ruleStrong, shape), contentAlignment = Alignment.Center) {
        Text((name ?: "V").take(1).uppercase(), style = (if (size >= 32.dp) Type.secondary else Type.micro).copy(fontWeight = androidx.compose.ui.text.font.FontWeight(600)), color = c.text)
    }
}

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

/** The top of a tab (the PWA's phone-head): the mark and wordmark, the box's name, and an action at the right. */
@Composable
fun BrandBar(right: String? = null, action: (@Composable () -> Unit)? = null) {
    Row(Modifier.fillMaxWidth().heightIn(min = Space.target).padding(top = Space.s, bottom = Space.s), verticalAlignment = Alignment.CenterVertically) {
        Mark(20.dp)
        Spacer(Modifier.width(6.dp))
        Wordmark(22.dp)
        Spacer(Modifier.weight(1f))
        if (right != null) Text(right, style = Type.monoSmall, color = V.c.text2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        if (action != null) { Spacer(Modifier.width(Space.m)); action() }
    }
}

/** The avatar at the right of Now's head: a round tile with the owner's initials; it opens Settings. */
@Composable
fun Avatar(initial: String, onClick: () -> Unit) {
    val c = V.c
    Box(
        Modifier.size(Space.target).clickable(role = Role.Button, onClickLabel = "Settings", onClick = onClick).semantics { contentDescription = "Settings" },
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(32.dp).background(c.hover, androidx.compose.foundation.shape.CircleShape)
            .border(1.dp, c.ruleStrong, androidx.compose.foundation.shape.CircleShape), contentAlignment = Alignment.Center) {
            Text(initial.take(2).uppercase().ifEmpty { "V" }, style = Type.button.copy(letterSpacing = androidx.compose.ui.unit.TextUnit.Unspecified), color = c.text)
        }
    }
}

/** A sheet's top row, 52 tall: its title in Group type, "Done" (17) on the right. */
@Composable
fun SheetTop(title: String, onDone: () -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 52.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = Type.group, color = V.c.text, modifier = Modifier.weight(1f))
        Box(Modifier.heightIn(min = Space.target).clickable(role = Role.Button, onClick = onDone).padding(start = Space.m), contentAlignment = Alignment.Center) {
            Text("Done", style = Type.input, color = V.c.text)
        }
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
 * The page: side gutter 16, a list. Everything is on the ground; sections are separated by rules
 * and labels, not boxes. There is no pull to refresh: pulling down from the top opens Find (Root),
 * as in the PWA, and screens re-read when they open and when the box says something changed.
 */
@Composable
fun Page(top: @Composable ColumnScope.() -> Unit = {}, content: LazyListScope.() -> Unit) {
    val shell = LocalInShell.current
    // In the shell, pages leave 56 + 16 under their last row so it clears the Capsule (phone.md section 3).
    val bottom = if (shell) Space.underCapsule + androidx.compose.foundation.layout.WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding() else Space.xxl
    Column(Modifier.fillMaxSize().background(if (shell) androidx.compose.ui.graphics.Color.Transparent else V.c.bg).then(if (shell) Modifier else Modifier.statusBarsPadding())) {
        Column(Modifier.padding(horizontal = Space.gutter), content = top)
        LazyColumn(Modifier.fillMaxSize(), state = rememberLazyListState(), contentPadding = PaddingValues(start = Space.gutter, end = Space.gutter, bottom = bottom), content = content)
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
                if (!sub.isNullOrEmpty()) Text(sub, style = Type.monoSmall, color = subColor ?: V.c.text2, maxLines = 1, overflow = TextOverflow.Ellipsis)
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
        Text(text, style = Type.small, color = V.c.text2)
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

/**
 * A one-line field on carbon: a label above, Signal only on the focus ring. `onGo` runs on the
 * keyboard's action key. `trailing` sits inside the field at the right (a voice button, a clear).
 */
@Composable
fun InputBox(
    value: String,
    onChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    mono: Boolean = false,
    imeAction: androidx.compose.ui.text.input.ImeAction = androidx.compose.ui.text.input.ImeAction.Go,
    keyboard: androidx.compose.ui.text.input.KeyboardType = androidx.compose.ui.text.input.KeyboardType.Text,
    onGo: () -> Unit = {},
    focusRequester: androidx.compose.ui.focus.FocusRequester? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    val c = V.c
    var focused by remember { mutableStateOf(false) }
    val shape = androidx.compose.foundation.shape.RoundedCornerShape(sh.vyre.app.design.Radius.panel)
    Row(
        modifier.fillMaxWidth().heightIn(min = Space.target + 4.dp)
            .background(c.panel, shape)
            .then(Modifier.border(if (focused) 2.dp else 1.dp, if (focused) c.focus else c.ruleStrong, shape))
            .padding(start = Space.m, end = if (trailing != null) 4.dp else Space.m),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.weight(1f).padding(vertical = Space.m)) {
            val style = (if (mono) Type.code else Type.body).copy(color = c.text)
            androidx.compose.foundation.text.BasicTextField(
                value, onChange, textStyle = style, singleLine = true,
                cursorBrush = androidx.compose.ui.graphics.SolidColor(c.focus),
                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                    imeAction = imeAction, keyboardType = keyboard, autoCorrectEnabled = !mono,
                    capitalization = if (mono) androidx.compose.ui.text.input.KeyboardCapitalization.None else androidx.compose.ui.text.input.KeyboardCapitalization.Sentences,
                ),
                keyboardActions = androidx.compose.foundation.text.KeyboardActions(onAny = { onGo() }),
                modifier = Modifier.fillMaxWidth()
                    .then(if (focusRequester != null) Modifier.focusRequester(focusRequester) else Modifier)
                    .onFocusChanged { focused = it.isFocused }
                    .semantics { contentDescription = placeholder },
                decorationBox = { inner -> if (value.isEmpty()) Text(placeholder, style = style.copy(color = c.label), maxLines = 1); inner() },
            )
        }
        if (trailing != null) trailing()
    }
}

/** A line of mono under a title: `a · b · c`, leaving out the empty parts. */
fun dots(vararg parts: String?): String = parts.filterNot { it.isNullOrBlank() }.joinToString(" · ")
