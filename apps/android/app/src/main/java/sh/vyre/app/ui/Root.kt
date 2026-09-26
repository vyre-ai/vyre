package sh.vyre.app.ui

import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import sh.vyre.app.MainActivity
import sh.vyre.app.api.arr
import sh.vyre.app.data.Links
import sh.vyre.app.design.Hairline
import sh.vyre.app.design.Label
import sh.vyre.app.design.Mark
import sh.vyre.app.design.Space
import sh.vyre.app.design.Type
import sh.vyre.app.design.V
import sh.vyre.app.push.Notifier
import sh.vyre.app.vyre

/** The five tabs, the PWA's order (docs/work/pwa.md, Changed contracts). */
enum class Tab(val label: String) { Now("Now"), Projects("Projects"), Chat("Chat"), Find("Find"), Agents("Agents") }

/**
 * The app: first run until this phone's key is enrolled with a box, then the tabs. Each tab keeps
 * its own stack of pushed screens; back pops it. Links (a notification's path, `vyre://`) land on
 * the tab they belong to.
 */
@Composable
fun Root(activity: MainActivity) {
    val app = activity.vyre
    CompositionLocalProvider(LocalApp provides app, LocalActivity provides activity) {
        val keyId by app.prefs.keyId.collectAsState()
        val address by app.prefs.address.collectAsState()
        if (keyId == null || address == null) FirstRun() else Main(activity)
    }
}

/** The route a launch or a tap carries: a notification's path extra, or a `vyre://` link. */
fun linkOf(intent: Intent?): String? {
    if (intent == null) return null
    intent.getStringExtra(Notifier.EXTRA_PATH)?.let { return Links.route(it) }
    return Links.route(intent.dataString)
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Main(activity: MainActivity) {
    val app = LocalApp.current
    var tab by rememberSaveable { mutableStateOf(Tab.Now) }
    val stacks = remember { Tab.entries.associateWith { mutableStateListOf<String>() } }
    val stack = stacks.getValue(tab)
    val nav: (String) -> Unit = { r -> if (stack.lastOrNull() != r) stack.add(r) }
    val back: () -> Unit = { if (stack.isNotEmpty()) stack.removeAt(stack.lastIndex) }
    BackHandler(enabled = stack.isNotEmpty()) { back() }

    // Any route, from a link, a push or a button in another tab: switch to the tab it belongs to
    // (Links.tabOf) and put it on top of that tab's list, so back lands on the list.
    val go: (String) -> Unit = { r ->
        val t = Tab.entries.firstOrNull { it.name.equals(Links.tabOf(r), true) } ?: Tab.Now
        tab = t
        stacks.getValue(t).apply { clear(); if (!r.startsWith("tab/")) add(r) }
    }

    // Links: a push's path (/needs/<id>, /threads/<id>) or vyre:// opens its item.
    val pending by activity.pending.collectAsState()
    LaunchedEffect(pending) {
        val i = pending ?: return@LaunchedEffect
        if (i.data?.host == "enrolled") return@LaunchedEffect
        activity.pending.value = null
        if (sh.vyre.app.BuildConfig.DEBUG) i.getStringExtra(EXTRA_TAB)?.let { t -> Tab.entries.firstOrNull { it.name.equals(t, true) }?.let { tab = it } }
        linkOf(i)?.let { go(it) }
    }

    // The needs badge on Now: held items plus open asks, re-read when either changes.
    val needs = rememberLoad("badge") {
        val h = runCatching { app.client.call("gate.held").arr.size }.getOrDefault(0)
        val a = runCatching { app.client.call("threads.asks").arr.size }.getOrDefault(0)
        h + a
    }
    OnEvents("ask.raised", "ask.answered", "gate.held", "gate.released", "gate.rejected", "gate.failed") { needs.refresh() }
    val connected by app.stream.connected.collectAsState()
    LaunchedEffect(connected) { if (connected) needs.refresh() }
    val offline by app.client.offline.collectAsState()
    val ime = WindowInsets.isImeVisible

    // Pull down from the top of any screen to open Find (the PWA's pullToFind): only the drag a
    // list could not use (it is already at the top) counts, and it must reach 72 dp.
    val density = androidx.compose.ui.platform.LocalDensity.current
    val threshold = with(density) { PULL_DP.dp.toPx() }
    var pull by remember { mutableStateOf(0f) }
    val openFind = { tab = Tab.Find; stacks.getValue(Tab.Find).clear() }
    val pullToFind = remember(tab) {
        object : androidx.compose.ui.input.nestedscroll.NestedScrollConnection {
            override fun onPreScroll(available: androidx.compose.ui.geometry.Offset, source: androidx.compose.ui.input.nestedscroll.NestedScrollSource): androidx.compose.ui.geometry.Offset {
                if (pull > 0f && available.y < 0f) { val used = maxOf(available.y, -pull); pull += used; return androidx.compose.ui.geometry.Offset(0f, used) }
                return androidx.compose.ui.geometry.Offset.Zero
            }
            override fun onPostScroll(consumed: androidx.compose.ui.geometry.Offset, available: androidx.compose.ui.geometry.Offset, source: androidx.compose.ui.input.nestedscroll.NestedScrollSource): androidx.compose.ui.geometry.Offset {
                if (tab == Tab.Find || source != androidx.compose.ui.input.nestedscroll.NestedScrollSource.UserInput || available.y <= 0f) return androidx.compose.ui.geometry.Offset.Zero
                pull += available.y * 0.5f
                return androidx.compose.ui.geometry.Offset(0f, available.y)
            }
            override suspend fun onPreFling(available: androidx.compose.ui.unit.Velocity): androidx.compose.ui.unit.Velocity {
                val ready = pull >= threshold
                pull = 0f
                if (ready) { openFind(); return available }
                return androidx.compose.ui.unit.Velocity.Zero
            }
        }
    }

    CompositionLocalProvider(LocalNav provides nav, LocalGo provides go) {
        Column(Modifier.fillMaxSize().background(V.c.ground)) {
            Box(Modifier.weight(1f).fillMaxWidth().nestedScroll(pullToFind)) {
                val top = stack.lastOrNull()
                if (top == null) when (tab) {
                    Tab.Now -> NowScreen()
                    Tab.Projects -> ProjectsScreen()
                    Tab.Chat -> ChatScreen()
                    Tab.Find -> FindScreen()
                    Tab.Agents -> AgentsScreen()
                } else Pushed(top, tab, stack.getOrNull(stack.lastIndex - 1), back)
                if (pull > 0f) PullHint(pull / threshold)
            }
            if (!ime) {
                if (offline) OfflineBar()
                TabBar(tab, needs.v.value ?: 0) { t ->
                    // Tapping the tab you are on goes back to its top.
                    if (t == tab) stacks.getValue(t).clear()
                    tab = t
                }
            }
        }
    }
}

/** A pushed screen, by its route string. */
@Composable
private fun Pushed(route: String, tab: Tab, prev: String?, back: () -> Unit) {
    val head = route.substringBefore('/')
    val rest = route.substringAfter('/', "")
    // The back label names the screen underneath: the tab, or the pushed screen it came from.
    val from = when (prev?.substringBefore('/')) {
        null -> tab.label
        "settings" -> "Settings"; "vault" -> "Vault"; "memory", "fact" -> "Memory"; "project" -> "Project"
        "thread" -> "Session"; "agent" -> android.net.Uri.decode(prev.substringAfter('/')); "needs" -> "Now"; "file" -> "File"
        else -> tab.label
    }
    when (head) {
        "thread" -> ThreadScreen(rest, back)
        "needs" -> NeedsScreen(rest, back)
        "project" -> ProjectScreen(rest, back)
        "file" -> FileScreen(android.net.Uri.decode(rest), from, back)
        "agent" -> AgentScreen(android.net.Uri.decode(rest), from, back)
        "memory" -> MemoryScreen(android.net.Uri.decode(rest), from, back)
        "fact" -> FactScreen(android.net.Uri.decode(rest), from, back)
        "vault" -> if (rest.isEmpty()) VaultScreen(from, back) else VaultItemScreen(android.net.Uri.decode(rest), back)
        "settings" -> SettingsScreen(back)
        else -> Page(top = { BackBar(from, back) }) { item { Quiet("Nothing is here.") } }
    }
}

/** Under the content when the box is out of reach. Quiet, not red. */
@Composable
private fun OfflineBar() {
    Column(Modifier.fillMaxWidth().background(V.c.panel)) {
        Hairline()
        Row(Modifier.fillMaxWidth().padding(horizontal = Space.gutter, vertical = Space.s), verticalAlignment = Alignment.CenterVertically) {
            sh.vyre.app.design.Dot(V.c.label)
            androidx.compose.foundation.layout.Spacer(Modifier.size(Space.s))
            Text("Offline. Showing what this phone kept.", style = Type.small, color = V.c.secondary)
        }
    }
}

@Composable
private fun TabBar(selection: Tab, badge: Int, onSelect: (Tab) -> Unit) {
    val c = V.c
    Column(Modifier.fillMaxWidth().background(c.ground).navigationBarsPadding()) {
        Hairline()
        Row(Modifier.fillMaxWidth().height(64.dp).padding(horizontal = Space.s), verticalAlignment = Alignment.CenterVertically) {
            TabItem(Tab.Now, Icons.Filled.Notifications, selection, badge, onSelect)
            TabItem(Tab.Projects, Icons.AutoMirrored.Filled.List, selection, 0, onSelect)
            TabItem(Tab.Chat, Icons.Filled.Email, selection, 0, onSelect)
            TabItem(Tab.Find, Icons.Filled.Search, selection, 0, onSelect)
            TabItem(Tab.Agents, Icons.Filled.Person, selection, 0, onSelect)
        }
    }
}

@Composable
private fun androidx.compose.foundation.layout.RowScope.TabItem(t: Tab, icon: ImageVector, selection: Tab, badge: Int, onSelect: (Tab) -> Unit) {
    val c = V.c
    val on = selection == t
    val tint = if (on) c.text else c.label
    Column(
        Modifier.weight(1f).height(56.dp).clip(RoundedCornerShape(sh.vyre.app.design.Radius.button))
            .clickable(role = Role.Tab, onClick = { onSelect(t) })
            .semantics { selected = on; contentDescription = if (t == Tab.Now && badge > 0) "${t.label}, $badge need you" else t.label },
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
    ) {
        Box {
            Icon(icon, null, tint = tint, modifier = Modifier.size(22.dp))
            if (badge > 0) Box(
                Modifier.align(Alignment.TopEnd).offset(x = 10.dp, y = (-6).dp).clip(RoundedCornerShape(50)).background(c.beaconDot)
                    .padding(horizontal = 5.dp, vertical = 1.dp),
            ) { Text(if (badge > 99) "99+" else "$badge", style = Type.label.copy(fontSize = 10.sp, letterSpacing = 0.sp), color = sh.vyre.app.design.Hex.signalInk) }
        }
        // The PWA's tab labels: mono 10, +0.14em, uppercase.
        Text(t.label.uppercase(), style = Type.label.copy(fontSize = 10.sp, lineHeight = 12.sp, letterSpacing = 0.14.em), color = tint, maxLines = 1, modifier = Modifier.padding(top = 6.dp))
    }
}

/** What a pull says, growing with it: "Pull to find", then "Release to find". */
@Composable
private fun PullHint(p: Float) {
    val c = V.c
    val f = p.coerceIn(0f, 1f)
    Column(Modifier.fillMaxWidth().statusBarsPadding().background(c.ground)) {
        Row(Modifier.fillMaxWidth().height((44 * f).dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
            Label(if (p >= 1f) "Release to find" else "Pull to find", color = if (p >= 1f) c.text else c.label)
        }
        Hairline()
    }
}

/** How far a pull must go to open Find, as in the PWA (THRESHOLD 72 px). */
private const val PULL_DP = 72

/** Debug builds only: `adb shell am start -e sh.vyre.app.TAB find` opens a tab, for screenshots. */
const val EXTRA_TAB = "sh.vyre.app.TAB"
