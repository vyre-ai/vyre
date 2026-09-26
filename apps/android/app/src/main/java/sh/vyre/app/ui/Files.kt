package sh.vyre.app.ui

import android.content.Intent
import android.graphics.BitmapFactory
import android.util.Base64
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import sh.vyre.app.api.ApiError
import sh.vyre.app.api.arr
import sh.vyre.app.api.at
import sh.vyre.app.api.bool
import sh.vyre.app.api.input
import sh.vyre.app.api.long
import sh.vyre.app.api.plain
import sh.vyre.app.api.str
import sh.vyre.app.data.bytes
import sh.vyre.app.design.ButtonKind
import sh.vyre.app.design.Radius
import sh.vyre.app.design.SectionHead
import sh.vyre.app.design.Space
import sh.vyre.app.design.Type
import sh.vyre.app.design.V
import sh.vyre.app.design.VButton
import java.io.File
import java.time.Instant

/**
 * Files: the box's files (CONTRACT.md 5). Over the tailnet the phone reaches only the box's files
 * module, whose root is /work; the Mac's files need a box-to-Mac link that does not exist yet.
 */
@Composable
fun FilesScreen() {
    val app = LocalApp.current
    val nav = LocalNav.current
    var q by rememberSaveable { mutableStateOf("") }
    var searched by rememberSaveable { mutableStateOf("") }
    var results by remember { mutableStateOf<Load<JsonElement>>(Load(null, null, false)) }
    val scope = rememberCoroutineScope()

    fun search(text: String) {
        val t = text.trim()
        if (t.isEmpty()) { results = Load(null, null, false); searched = ""; return }
        searched = t
        results = Load(results.value, null, true)
        scope.launch {
            results = try { Load(app.client.call("files.search", input("q" to t, "limit" to 50)), null, false) }
            catch (e: Exception) { if (e is kotlinx.coroutines.CancellationException) throw e; Load(null, e, false) }
        }
    }
    // Search as the person pauses typing, at most once per 400 ms.
    LaunchedEffect(q) { if (q.trim().length >= 2 && q.trim() != searched) { delay(400); search(q) } }

    val rows = results.value.at("results").arr
    val sources = results.value.at("sources").arr
    Page(top = {
        BrandBar()
        Text("Files", style = Type.h1, color = V.c.text, modifier = Modifier.padding(top = Space.s, bottom = Space.m))
        InputBox(q, { q = it }, "Search the box's files", imeAction = ImeAction.Search, onGo = { search(q) })
    }) {
        if (searched.isEmpty()) {
            item {
                Quiet("Search by name for anything on the box, under /work. This phone reaches the box only: the Mac's files are not reachable from a phone yet.", "box only")
            }
            return@Page
        }
        item { SectionHead("Results · ${rows.size}", sources.firstOrNull()?.str("source")) }
        loadState(results, rows.isEmpty(), "Nothing on the box matches \"$searched\".")
        sources.filter { it.bool("ok") == false }.forEach { s -> item { Quiet(s.str("error") ?: s.str("note") ?: "A source failed.", s.str("source")) } }
        items(rows, key = { "f" + it.str("path") }) { f ->
            Row2(f.str("name") ?: f.str("path").orEmpty(), dots(f.str("kind"), bytes(f.long("size")).takeIf { f.str("kind") != "folder" }, f.str("path")),
                onClick = { f.str("path")?.let { nav("file/" + android.net.Uri.encode(it)) } })
        }
    }
}

/** One file: what the box can preview (an image thumbnail, text), and Open, which fetches it to this phone. */
@Composable
fun FileScreen(path: String, onBack: () -> Unit) {
    val app = LocalApp.current
    val activity = LocalActivity.current
    val scope = rememberCoroutineScope()
    val stat = rememberLoad("stat", path) { app.client.call("files.stat", input("path" to path)) }
    val preview = rememberLoad("preview", path) { app.client.call("files.preview", input("path" to path, "max" to 262144)) }
    var note by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val s = stat.v.value
    val p = preview.v.value
    val c = V.c

    fun open() {
        busy = true; note = "Fetching"
        scope.launch {
            try {
                val f = fetch(app, path, activity.cacheDir) { done, total -> note = "Fetching ${bytes(done)} of ${bytes(total)}" }
                val uri = FileProvider.getUriForFile(activity, activity.packageName + ".files", f)
                val mime = s.str("mime") ?: p.str("mime") ?: "application/octet-stream"
                val view = Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                activity.startActivity(Intent.createChooser(view, f.name))
                note = null
            } catch (e: android.content.ActivityNotFoundException) { note = "No app on this phone opens this kind of file."
            } catch (e: Exception) { note = e.plain() }
            busy = false
        }
    }

    Page(top = { BackBar("Files", onBack) }) {
        item {
            Text(s.str("name") ?: path.substringAfterLast('/'), style = Type.h2, color = c.text)
            Text(dots(s.str("kind"), bytes(s.long("size")), s.str("mtime")?.let { runCatching { sh.vyre.app.data.ago(Instant.parse(it).toEpochMilli()) + " ago" }.getOrNull() }),
                style = Type.monoSmall, color = c.secondary, modifier = Modifier.padding(top = 4.dp))
            Text(path, style = Type.monoSmall, color = c.label, modifier = Modifier.padding(top = 2.dp))
            if (stat.v.error != null) Quiet(stat.v.error!!.plain(), "failed")
        }
        if (s != null && s.bool("dir") != true) item {
            Column(Modifier.padding(top = Space.l)) {
                VButton(if (busy) "Fetching" else "Open on this phone", onClick = { open() }, kind = ButtonKind.Primary, enabled = !busy && (s.long("size") ?: 0L) <= MAX_FETCH)
                if ((s.long("size") ?: 0L) > MAX_FETCH) Quiet("Larger than ${bytes(MAX_FETCH)}; open it on the Mac.")
                note?.let { Quiet(it) }
            }
        }
        item { SectionHead("Preview") }
        item {
            when {
                p == null && preview.v.loading -> Quiet("Loading")
                p == null -> Quiet(preview.v.error?.plain() ?: "No preview.")
                p.str("kind") == "image" && p.str("base64") != null -> {
                    val bmp = remember(p) { runCatching { Base64.decode(p.str("base64"), Base64.DEFAULT).let { BitmapFactory.decodeByteArray(it, 0, it.size) } }.getOrNull() }
                    if (bmp != null) Image(bmp.asImageBitmap(), s.str("name"), contentScale = ContentScale.FillWidth,
                        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.panel)))
                    else Quiet("The image could not be read.")
                    p.str("note")?.let { Quiet(it) }
                }
                p.at("text") != null -> Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(Radius.button)).background(if (c.dark) c.code else c.raised)
                    .horizontalScroll(rememberScrollState()).padding(Space.m)) {
                    Text(p.str("text").orEmpty(), style = Type.code, color = c.text, softWrap = false)
                    if (p.bool("truncated") == true) Text("The rest is not shown.", style = Type.small, color = c.label, modifier = Modifier.padding(top = Space.s))
                }
                else -> Quiet("No preview for this kind of file.")
            }
        }
    }
}

const val MAX_FETCH = 50L * 1024 * 1024

/**
 * files.fetch in 1 MiB base64 chunks into the app's cache (CONTRACT.md 5: no byte route; the
 * size and mtime must stay the same across chunks, or the file changed while it came).
 */
suspend fun fetch(app: sh.vyre.app.VyreApp, path: String, cacheDir: File, progress: (Long, Long) -> Unit): File {
    val name = path.substringAfterLast('/').replace(Regex("[^A-Za-z0-9._ -]"), "_").ifBlank { "file" }
    val dir = File(cacheDir, "fetched").apply { mkdirs() }
    val out = File(dir, name)
    var offset = 0L
    var size: Long? = null
    var mtime: String? = null
    withContext(Dispatchers.IO) { out.delete() }
    while (true) {
        val chunk = app.client.call("files.fetch", input("path" to path, "offset" to offset, "length" to CHUNK), timeoutSec = 60)
        val sz = chunk.long("size"); val mt = chunk.str("mtime")
        if (size == null) { size = sz; mtime = mt }
        else if (sz != size || mt != mtime) throw ApiError.Other("changed", "The file changed on the box while it came. Try again.", 0)
        val b64 = chunk.str("base64") ?: throw ApiError.Other("failed", "The box sent no bytes.", 0)
        val bytes = withContext(Dispatchers.Default) { Base64.decode(b64, Base64.DEFAULT) }
        withContext(Dispatchers.IO) { out.appendBytes(bytes) }
        offset += bytes.size
        progress(offset, size ?: offset)
        if (chunk.bool("done") == true || bytes.isEmpty() || (size != null && offset >= size)) break
    }
    return out
}

private const val CHUNK = 1024 * 1024
