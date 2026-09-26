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
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.MoreVert
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

/** The five tabs, as on iOS: the Capsule in the centre, raised. */
enum class Tab(val label: String) { Now("Now"), Chat("Chat"), Capsule("Capsule"), Files("Files"), More("More") }

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

    // Links: a push opens its item on Now (needs) or Chat (a thread); settings under More.
    val pending by activity.pending.collectAsState()
    LaunchedEffect(pending) {
        val i = pending ?: return@LaunchedEffect
        if (i.data?.host == "enrolled") return@LaunchedEffect
        activity.pending.value = null
        if (sh.vyre.app.BuildConfig.DEBUG) i.getStringExtra(EXTRA_TAB)?.let { t -> Tab.entries.firstOrNull { it.name.equals(t, true) }?.let { tab = it } }
        val r = linkOf(i) ?: return@LaunchedEffect
        val (t, route) = when {
            r.startsWith("tab/") -> (Tab.entries.firstOrNull { it.name.equals(r.removePrefix("tab/"), true) } ?: Tab.Now) to null
            r.startsWith("needs/") -> Tab.Now to r
            r.startsWith("thread/") -> Tab.Chat to r
            r == "settings" -> Tab.More to r
            else -> Tab.Now to null
        }
        tab = t
        stacks.getValue(t).apply { clear(); if (route != null) add(route) }
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

    CompositionLocalProvider(LocalNav provides nav) {
        Column(Modifier.fillMaxSize().background(V.c.ground)) {
            Box(Modifier.weight(1f).fillMaxWidth()) {
                val top = stack.lastOrNull()
                if (top == null) when (tab) {
                    Tab.Now -> NowScreen()
                    Tab.Chat -> ChatScreen()
                    Tab.Capsule -> CapsuleScreen()
                    Tab.Files -> FilesScreen()
                    Tab.More -> MoreScreen()
                } else Pushed(top, tab, back)
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
private fun Pushed(route: String, tab: Tab, back: () -> Unit) {
    val head = route.substringBefore('/')
    val rest = route.substringAfter('/', "")
    val from = tab.label
    when (head) {
        "thread" -> ThreadScreen(rest, back)
        "needs" -> NeedsScreen(rest, back)
        "project" -> ProjectScreen(rest, back)
        "file" -> FileScreen(android.net.Uri.decode(rest), back)
        "agents" -> AgentsScreen(back)
        "agent" -> AgentScreen(android.net.Uri.decode(rest), back)
        "memory" -> MemoryScreen(back)
        "fact" -> FactScreen(android.net.Uri.decode(rest), back)
        "vault" -> if (rest.isEmpty()) VaultScreen(back) else VaultItemScreen(android.net.Uri.decode(rest), back)
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
            TabItem(Tab.Chat, Icons.Filled.Email, selection, 0, onSelect)
            CapsuleItem(selection == Tab.Capsule) { onSelect(Tab.Capsule) }
            TabItem(Tab.Files, Icons.AutoMirrored.Filled.List, selection, 0, onSelect)
            TabItem(Tab.More, Icons.Filled.MoreVert, selection, 0, onSelect)
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
            ) { Text(if (badge > 99) "99+" else "$badge", style = Type.label.copy(fontSize = androidx.compose.ui.unit.TextUnit(10f, androidx.compose.ui.unit.TextUnitType.Sp)), color = sh.vyre.app.design.Hex.signalInk) }
        }
        Label(t.label, Modifier.padding(top = 4.dp), color = tint)
    }
}

/** The Capsule: centre, raised, the one pill in the bar, the mark inside it. */
@Composable
private fun androidx.compose.foundation.layout.RowScope.CapsuleItem(on: Boolean, onClick: () -> Unit) {
    val c = V.c
    Box(Modifier.weight(1.2f), contentAlignment = Alignment.Center) {
        Box(
            Modifier.offset(y = (-10).dp).size(width = 68.dp, height = 44.dp).clip(RoundedCornerShape(50))
                .background(if (on) c.primaryFill else c.raised)
                .border(1.dp, if (on) c.primaryFill else c.ruleStrong, RoundedCornerShape(50))
                .clickable(role = Role.Tab, onClick = onClick)
                .semantics { selected = on; contentDescription = "Capsule" },
            contentAlignment = Alignment.Center,
        ) { Mark(22.dp, wire = if (on) c.primaryInk else c.text, dot = if (on) c.primaryInk else c.dot) }
    }
}

/** Debug builds only: `adb shell am start -e sh.vyre.app.TAB capsule` opens a tab, for screenshots. */
const val EXTRA_TAB = "sh.vyre.app.TAB"
