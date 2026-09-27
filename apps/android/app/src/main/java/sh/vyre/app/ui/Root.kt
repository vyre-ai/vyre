package sh.vyre.app.ui

import android.content.Intent
import android.view.HapticFeedbackConstants
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import sh.vyre.app.MainActivity
import sh.vyre.app.api.arr
import sh.vyre.app.api.at
import sh.vyre.app.api.str
import sh.vyre.app.data.Anchor
import sh.vyre.app.data.Links
import sh.vyre.app.data.Speaker
import sh.vyre.app.data.initials
import sh.vyre.app.design.Hairline
import sh.vyre.app.design.Mark
import sh.vyre.app.design.Radius
import sh.vyre.app.design.Space
import sh.vyre.app.design.Type
import sh.vyre.app.design.V
import sh.vyre.app.push.Notifier
import sh.vyre.app.vyre
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** The three pages (phone.md section 3). Find is not a page: it is the Capsule, opened. */
enum class PageId(val label: String) { Now("Now"), Chats("Chats"), Agents("Agents") }

/**
 * The app: first run until this phone's key is enrolled with a box, then the shell.
 */
@Composable
fun Root(activity: MainActivity) {
    val app = activity.vyre
    CompositionLocalProvider(LocalApp provides app, LocalActivity provides activity) {
        val keyId by app.prefs.keyId.collectAsState()
        val address by app.prefs.address.collectAsState()
        if (keyId == null || address == null) FirstRun() else Shell(activity)
    }
}

/** The route a launch or a tap carries: a notification's path extra, or a `vyre://` link. */
fun linkOf(intent: Intent?): String? {
    if (intent == null) return null
    intent.getStringExtra(Notifier.EXTRA_PATH)?.let { return Links.route(it) }
    return Links.route(intent.dataString)
}

/** A short line over the Capsule for a few seconds, with an optional action (Undo). */
data class Toast(val text: String, val action: String? = null, val ms: Long = 3000, val onAction: (() -> Unit)? = null, val id: Long = System.nanoTime())

/**
 * The shell (phone.md section 3): no tab bar. A 48 tall header with the mark, the page labels and
 * the avatar; three pages side by side in a pager; the Capsule floating over the bottom. Pushed
 * screens (a chat, an agent, a held item) slide in from the right over everything. Settings and
 * Find are sheets.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Shell(activity: MainActivity) {
    val app = LocalApp.current
    val view = LocalView.current
    val scope = rememberCoroutineScope()
    val prefs = remember { activity.getSharedPreferences("shell", android.content.Context.MODE_PRIVATE) }
    val pager = rememberPagerState(initialPage = prefs.getInt("page", 0).coerceIn(0, 2)) { PageId.entries.size }
    val stack = remember { mutableStateListOf<String>() }
    var sheet by remember { mutableStateOf<String?>(null) }
    var toast by remember { mutableStateOf<Toast?>(null) }

    fun showPage(p: PageId) { stack.clear(); scope.launch { pager.animateScrollToPage(p.ordinal) } }
    // A held item, an ask or a question opens its detail sheet over whatever is showing (phone.md section 5).
    val nav: (String) -> Unit = { r -> if (r == "settings" || r.startsWith("needs/")) sheet = r else if (stack.lastOrNull() != r) stack.add(r) }
    // Any route, from a link, a push or a button elsewhere: the page it belongs to, with the route on top.
    val go: (String) -> Unit = { r ->
        when {
            r == "tab/find" -> sheet = "find"
            r == "settings" -> { showPage(PageId.Now); sheet = "settings" }
            r.startsWith("needs/") -> { showPage(PageId.Now); sheet = r }
            else -> {
                val p = PageId.entries.firstOrNull { it.name.equals(Links.tabOf(r), true) } ?: PageId.Now
                sheet = null
                showPage(p)
                if (!r.startsWith("tab/")) stack.add(r)
            }
        }
    }
    val back: () -> Unit = { if (stack.isNotEmpty()) stack.removeAt(stack.lastIndex) }
    BackHandler(enabled = stack.isNotEmpty()) { back() }

    // Links: a push's path (/needs/<id>, /threads/<id>) or vyre:// opens its item: a need's sheet, a session.
    val pending by activity.pending.collectAsState()
    LaunchedEffect(pending) {
        val i = pending ?: return@LaunchedEffect
        if (i.data?.host == "enrolled") return@LaunchedEffect
        activity.pending.value = null
        if (sh.vyre.app.BuildConfig.DEBUG) i.getStringExtra(EXTRA_TAB)?.let { t ->
            if (t.equals("find", true)) sheet = "find" else PageId.entries.firstOrNull { it.name.equals(t, true) }?.let { showPage(it) }
        }
        linkOf(i)?.let { go(it) }
    }

    // What needs you: the mark's dot turns Beacon, and the app opens on Now when anything does.
    val needs = rememberLoad("badge") {
        val h = runCatching { app.client.call("gate.held").arr.size }.getOrDefault(0)
        val a = runCatching { app.client.call("threads.asks").arr.size }.getOrDefault(0)
        h + a
    }
    OnEvents("ask.raised", "ask.answered", "gate.held", "gate.released", "gate.rejected", "gate.failed") { needs.refresh() }
    val connected by app.stream.connected.collectAsState()
    LaunchedEffect(connected) { if (connected) needs.refresh() }
    var openedOnNow by remember { mutableStateOf(false) }
    LaunchedEffect(needs.v.value) {
        val n = needs.v.value ?: return@LaunchedEffect
        if (!openedOnNow) { openedOnNow = true; if (n > 0 && stack.isEmpty() && pending == null) pager.scrollToPage(0) }
    }
    // The page is kept for next time; a snap ticks (phone.md section 10: CLOCK_TICK).
    var firstSettle by remember { mutableStateOf(true) }
    LaunchedEffect(pager.settledPage) {
        prefs.edit().putInt("page", pager.settledPage).apply()
        if (firstSettle) firstSettle = false else view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    }

    val address by app.prefs.address.collectAsState()
    val host = address?.substringAfter("://")?.trimEnd('/')
    val info = rememberLoad("system-info") { runCatching { app.client.call("system.info") }.getOrNull() }
    val agents = rememberLoad("shell-agents") { runCatching { app.client.call("agents.list").arr.toList() }.getOrDefault(emptyList()) }
    val assistant = Speaker.assistant(agents.v.value.orEmpty(), info.v.value)
    val avatar = initials(info.v.value.at("owner").str("name"), host)

    CompositionLocalProvider(LocalNav provides nav, LocalGo provides go, LocalToast provides { t -> toast = t }) {
        Box(Modifier.fillMaxSize().background(V.c.bg)) {
            AnimatedContent(
                targetState = stack.lastOrNull(),
                transitionSpec = {
                    val forward = targetState != null && (initialState == null || stack.size > 1 && targetState == stack.last())
                    if (forward) slideInHorizontally(tween(220)) { it } togetherWith fadeOut(tween(160))
                    else fadeIn(tween(160)) togetherWith slideOutHorizontally(tween(220)) { it }
                },
                label = "pushed",
            ) { top ->
                if (top == null) Column(Modifier.fillMaxSize()) {
                    Header(pager.currentPage + pager.currentPageOffsetFraction, needs.v.value ?: 0, avatar,
                        onPage = { p -> scope.launch { pager.animateScrollToPage(p.ordinal) } },
                        onAvatar = { sheet = "settings" },
                        onNewAgent = { sheet = "newagent" })
                    OfflineLine()
                    CompositionLocalProvider(LocalInShell provides true) {
                        HorizontalPager(pager, Modifier.weight(1f).fillMaxWidth(), beyondViewportPageCount = 1) { i ->
                            CompositionLocalProvider(LocalOnScreen provides (pager.settledPage == i && sheet == null)) {
                                when (PageId.entries[i]) {
                                    PageId.Now -> NowScreen()
                                    PageId.Chats -> ChatScreen()
                                    PageId.Agents -> AgentsScreen()
                                }
                            }
                        }
                    }
                } else Pushed(top, stack.getOrNull(stack.lastIndex - 1), back)
            }
            if (stack.isEmpty()) Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth()) {
                ToastLine(toast) { toast = null }
                Capsule(assistant, onOpen = { sheet = "find" }, onMic = { toast = Toast("Dictation is not in this build yet. Type in Find instead.") })
            } else ToastLine(toast, Modifier.align(Alignment.BottomCenter).navigationBarsPadding()) { toast = null }
        }

        // Sheets: Settings (from the avatar) and Find (the Capsule, opened), both full height.
        val close = { sheet = null }
        val inSheetNav: (String) -> Unit = { r -> if (!r.startsWith("needs/")) sheet = null; nav(r) }
        val inSheetGo: (String) -> Unit = { r -> sheet = null; go(r) }
        // A need's sheet may open another need's (Details on a card), so the sheet is keyed by what it shows.
        val current = sheet
        if (current != null) androidx.compose.runtime.key(current) {
            ModalBottomSheet(
                onDismissRequest = close,
                sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
                containerColor = V.c.panel,
                scrimColor = V.c.scrim,
                shape = RoundedCornerShape(topStart = Radius.window, topEnd = Radius.window),
                dragHandle = { Grabber() },
            ) {
                CompositionLocalProvider(LocalNav provides inSheetNav, LocalGo provides inSheetGo, LocalInShell provides true) {
                    Box(Modifier.fillMaxWidth().fillMaxHeight()) {
                        when {
                            current == "settings" -> SettingsScreen(onBack = close)
                            current == "find" -> FindScreen(onClose = close)
                            current == "newagent" -> NewAgentSheet(onClose = close)
                            current.startsWith("needs/") -> NeedSheet(current.removePrefix("needs/"), onClose = close)
                        }
                    }
                }
            }
        }
    }
}

/** A pushed screen, by its route string. `prev` names the back label. */
@Composable
private fun Pushed(route: String, prev: String?, back: () -> Unit) {
    val head = route.substringBefore('/')
    val rest = route.substringAfter('/', "")
    val from = when (prev?.substringBefore('/')) {
        null -> "Back"
        "vault" -> "Vault"; "memory", "fact" -> "Memory"; "project" -> "Project"
        "thread" -> "Session"; "agent" -> android.net.Uri.decode(prev.substringAfter('/')); "needs" -> "Now"; "file" -> "File"
        else -> "Back"
    }
    when (head) {
        "thread" -> Anchor.parse(rest).let { (id, anchor) -> ThreadScreen(id, anchor, back) }
        "project" -> ProjectScreen(rest, back)
        "file" -> FileScreen(android.net.Uri.decode(rest), from, back)
        "agent" -> AgentScreen(android.net.Uri.decode(rest), from, back)
        "memory" -> MemoryScreen(android.net.Uri.decode(rest), from, back)
        "fact" -> FactScreen(android.net.Uri.decode(rest), from, back)
        "vault" -> if (rest.isEmpty()) VaultScreen(from, back) else VaultItemScreen(android.net.Uri.decode(rest), back)
        else -> Page(top = { BackBar(from, back) }) { item { Quiet("Nothing is here.") } }
    }
}

/**
 * The header, 48 tall under the status bar: the mark (its dot Beacon when anything needs you),
 * the three page labels (the current one in --text, the others in --label, crossfading with the
 * swipe), and the avatar, which opens Settings. On Agents the avatar's place holds "+".
 */
@Composable
private fun Header(position: Float, needs: Int, avatar: String, onPage: (PageId) -> Unit, onAvatar: () -> Unit, onNewAgent: () -> Unit) {
    val c = V.c
    Row(Modifier.fillMaxWidth().statusBarsPadding().height(Space.header).padding(horizontal = Space.gutter), verticalAlignment = Alignment.CenterVertically) {
        Mark(22.dp, wire = c.markWire, dot = if (needs > 0) c.beaconDot else c.markDot,
            modifier = Modifier.semantics { contentDescription = if (needs > 0) "Vyre, $needs need you" else "Vyre" })
        Spacer(Modifier.width(Space.l))
        Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(Space.l), verticalAlignment = Alignment.CenterVertically) {
            for (p in PageId.entries) {
                val near = 1f - kotlin.math.abs(position - p.ordinal).coerceIn(0f, 1f)
                Text(p.label, style = Type.page, color = lerp(c.label, c.text, near), maxLines = 1, overflow = TextOverflow.Clip,
                    modifier = Modifier.clickable(role = Role.Tab, onClick = { onPage(p) }).semantics { selected = near > 0.5f })
            }
        }
        if (position > PageId.Agents.ordinal - 0.5f) {
            Box(Modifier.size(44.dp).clickable(role = Role.Button, onClickLabel = "New agent", onClick = onNewAgent), contentAlignment = Alignment.Center) {
                Text("+", style = Type.page, color = c.text)
            }
        } else Box(Modifier.size(44.dp).clickable(role = Role.Button, onClickLabel = "Settings", onClick = onAvatar).semantics { contentDescription = "Settings" }, contentAlignment = Alignment.Center) {
            Box(Modifier.size(34.dp).background(c.hover, CircleShape).border(1.dp, c.ruleStrong, CircleShape), contentAlignment = Alignment.Center) {
                Text(avatar.take(2), style = Type.meta.copy(fontWeight = androidx.compose.ui.text.font.FontWeight(600)), color = c.text)
            }
        }
    }
}

/** Under the header when the box is out of reach (phone.md section 11), with Retry. */
@Composable
private fun OfflineLine() {
    val app = LocalApp.current
    val scope = rememberCoroutineScope()
    val offline by app.client.offline.collectAsState()
    val last by app.client.lastOk.collectAsState()
    if (!offline) return
    val at = last?.let { " Showing what it said at " + SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date(it)) + "." } ?: ""
    Row(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = Space.s), verticalAlignment = Alignment.CenterVertically) {
        Text("Can't reach your box.$at", style = Type.meta, color = V.c.text2, modifier = Modifier.weight(1f))
        Box(Modifier.size(width = 64.dp, height = 44.dp).clickable(role = Role.Button, onClick = { scope.launch { runCatching { app.client.health() } } }), contentAlignment = Alignment.CenterEnd) {
            Text("Retry", style = Type.button, color = V.c.text)
        }
    }
    Hairline()
}

/**
 * The Capsule (phone.md section 3): floating 12 from each side on the bottom safe area, 56 tall,
 * --panel with a --rule-strong border and the float shadow. Tap or drag up opens Find; hold the
 * mic to dictate (not in this build: it says so and nothing is recorded).
 */
@Composable
private fun Capsule(assistant: String, onOpen: () -> Unit, onMic: () -> Unit) {
    val c = V.c
    val view = LocalView.current
    val density = LocalDensity.current
    var dragged by remember { mutableStateOf(0f) }
    Row(
        Modifier.navigationBarsPadding().padding(start = 12.dp, end = 12.dp, bottom = 8.dp).fillMaxWidth().height(Space.capsule)
            .shadow(24.dp, CircleShape, ambientColor = Color.Black, spotColor = Color.Black)
            .clip(CircleShape).background(c.panel).border(1.dp, c.ruleStrong, CircleShape)
            .pointerInputDragUp(onUp = onOpen, threshold = with(density) { 24.dp.toPx() }, dragged = { dragged = it })
            .clickable(role = Role.Button, onClickLabel = "Open Find", onClick = onOpen)
            .padding(start = Space.l, end = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Mark(20.dp, wire = c.markWire, dot = c.markDot)
        Spacer(Modifier.width(Space.m))
        Text("Ask $assistant, find, or run", style = Type.secondary, color = c.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        // The mic: hold to dictate. Dictation is not in this build, so a hold says so.
        Box(
            Modifier.size(40.dp).clip(CircleShape).background(c.hover)
                .semantics { contentDescription = "Dictate, not in this build"; onClick("Dictate") { onMic(); true } }
                .pointerInputHold(onStart = { view.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY); onMic() },
                    onEnd = { view.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY) }),
            contentAlignment = Alignment.Center,
        ) { MicGlyph(c.label) }
    }
}

private fun Modifier.pointerInputDragUp(onUp: () -> Unit, threshold: Float, dragged: (Float) -> Unit): Modifier =
    this.then(Modifier.pointerInput(Unit) {
        var total = 0f
        detectVerticalDragGestures(onDragStart = { total = 0f }, onDragEnd = { if (-total > threshold) onUp(); dragged(0f) }, onDragCancel = { dragged(0f) }) { _, dy ->
            total += dy; dragged(total)
        }
    })

private fun Modifier.pointerInputHold(onStart: () -> Unit, onEnd: () -> Unit): Modifier =
    this.then(Modifier.pointerInput(Unit) {
        detectTapGestures(onPress = { onStart(); tryAwaitRelease(); onEnd() })
    })

/** A small stroke mic on the 24 grid, 1.5 stroke (phone.md icons). */
@Composable
private fun MicGlyph(color: Color) {
    androidx.compose.foundation.Canvas(Modifier.size(20.dp)) {
        val u = size.width / 24f
        val st = androidx.compose.ui.graphics.drawscope.Stroke(width = 1.5f * u, cap = androidx.compose.ui.graphics.StrokeCap.Round)
        drawRoundRect(color, topLeft = androidx.compose.ui.geometry.Offset(9f * u, 3f * u), size = androidx.compose.ui.geometry.Size(6f * u, 11f * u),
            cornerRadius = androidx.compose.ui.geometry.CornerRadius(3f * u), style = st)
        drawArc(color, 0f, 180f, false, topLeft = androidx.compose.ui.geometry.Offset(5.5f * u, 6f * u), size = androidx.compose.ui.geometry.Size(13f * u, 11f * u), style = st)
        drawLine(color, androidx.compose.ui.geometry.Offset(12f * u, 17f * u), androidx.compose.ui.geometry.Offset(12f * u, 21f * u), strokeWidth = 1.5f * u, cap = androidx.compose.ui.graphics.StrokeCap.Round)
    }
}

/** The toast over the Capsule: one line, and its action (Undo) as a button. Leaves after `ms`. */
@Composable
private fun ToastLine(t: Toast?, modifier: Modifier = Modifier, gone: () -> Unit) {
    if (t == null) return
    LaunchedEffect(t.id) { delay(t.ms); gone() }
    val c = V.c
    Row(
        modifier.padding(horizontal = 12.dp, vertical = 6.dp).fillMaxWidth().clip(RoundedCornerShape(Radius.panel))
            .background(c.text).padding(start = Space.l, end = 4.dp).height(48.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(t.text, style = Type.secondary, color = c.bg, modifier = Modifier.weight(1f), maxLines = 2)
        if (t.action != null) Box(Modifier.height(44.dp).clickable(role = Role.Button) { t.onAction?.invoke(); gone() }.padding(horizontal = Space.m), contentAlignment = Alignment.Center) {
            Text(t.action, style = Type.button, color = c.bg)
        }
    }
}

/** Debug builds only: `adb shell am start -e sh.vyre.app.TAB chats` opens a page (or `find`), for screenshots. */
const val EXTRA_TAB = "sh.vyre.app.TAB"
