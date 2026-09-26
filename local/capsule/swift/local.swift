// local: the Capsule's on-device lookups that Node cannot reach: Contacts, the Dictionary, and
// the icons the launcher draws beside its results.
//
//   local contacts --status              the Contacts permission, never prompting
//   local contacts <query> [--limit N]   people whose name (or exact email) matches
//   local define <word>                  the system dictionary's definition, or null
//   local serve                          one JSON request per stdin line, one JSON answer each
//
// Every answer is one JSON line on stdout. The Capsule runs `serve` as a long-lived child: a
// process spawn per keystroke costs more than the lookup itself, and the launcher's budget is a
// few tens of milliseconds. Requests in serve mode look like
//   {"id":1,"op":"contacts","q":"ann","limit":5}   {"id":2,"op":"define","q":"serendipity"}
//   {"id":3,"op":"status"}
//   {"id":4,"op":"icons","items":[{"key":"...","kind":"app","path":"/Applications/X.app"}],"size":64,"dir":"/cache"}
//   {"id":5,"op":"clip.watch","on":true}   {"id":6,"op":"clip.write","text":"..."}
//   {"id":7,"op":"front"}   the app in front now: {"front":{"bundle","pid","name"}} or {"front":null}
// and each answer carries the same id. The clipboard watcher also writes unsolicited lines,
// {"event":"clip","item":{...}}, with no id (see the clipboard section). Answers can arrive out of order: a contacts fetch never
// holds up a definition. Serve exits when stdin closes, so a crashed Capsule leaves nothing.
//
// Nothing here touches the network or writes anything down (proposal section 5). A query goes in,
// matches come out, and neither is kept. The one exception is `icons`, which writes PNGs into the
// cache directory the caller names, and nowhere else. Clipboard items go to stdout only; the
// Capsule keeps them in a file of its own and never sends them anywhere.
//
// Only `contacts <query>` may ask for the Contacts permission, and only while macOS has never
// been asked (notDetermined). `--status` and the serve `status` op read it without asking, so
// the Capsule can say why it wants access before the dialog appears. In serve mode the ask does
// not block: the first contacts request answers {"error":"asking"} at once and the dialog runs
// on its own; the next request after the user answers gets real results.
//
// Whose permission it is: macOS (TCC) attributes the ask to the RESPONSIBLE process, not to this
// binary. Spawned from the Capsule, that is the Electron app: the packaged Vyre app, or
// Electron.app itself in development. Run from a shell, it is the terminal. The grant appears
// under that app's name in Privacy & Security > Contacts, and that app's Info.plist must carry
// NSContactsUsageDescription or macOS refuses without showing a dialog. build.sh also embeds an
// Info.plist with that key in this binary, which covers the case where it is its own
// responsible process (launched by launchd, or by a parent that disclaims responsibility).
//
// build: local/capsule/build.sh

import AppKit
import Contacts
import CoreServices
import CryptoKit
import QuickLookThumbnailing
import UniformTypeIdentifiers

let outLock = NSLock()
func emit(_ obj: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: data, encoding: .utf8) {
        outLock.lock()
        print(s)
        fflush(stdout)
        outLock.unlock()
    }
}

// MARK: contacts

func statusName() -> String {
    switch CNContactStore.authorizationStatus(for: .contacts) {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    default: return "limited"   // CNAuthorizationStatusLimited (raw 4) is not named in the macOS SDK
    }
}

let store = CNContactStore()
let keys: [CNKeyDescriptor] = [
    CNContactIdentifierKey as CNKeyDescriptor,
    CNContactOrganizationNameKey as CNKeyDescriptor,
    CNContactEmailAddressesKey as CNKeyDescriptor,
    CNContactPhoneNumbersKey as CNKeyDescriptor,
    CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
]

func shape(_ c: CNContact) -> [String: Any] {
    let name = CNContactFormatter.string(from: c, style: .fullName) ?? ""
    return [
        "id": c.identifier,
        "name": name.isEmpty ? (c.organizationName) : name,
        "org": c.organizationName,
        "emails": c.emailAddresses.map { $0.value as String },
        "phones": c.phoneNumbers.map { $0.value.stringValue },
    ]
}

/// The matches, or an error answer. Assumes access was already granted.
func search(_ q: String, limit: Int) -> [String: Any] {
    let query = q.trimmingCharacters(in: .whitespaces)
    if query.isEmpty { return ["contacts": []] }
    var seen = Set<String>()
    var out: [[String: Any]] = []
    do {
        var found = try store.unifiedContacts(matching: CNContact.predicateForContacts(matchingName: query), keysToFetch: keys)
        // An email match is cheap only as an exact address: Contacts indexes it that way.
        if query.contains("@") && query.contains(".") {
            found += try store.unifiedContacts(matching: CNContact.predicateForContacts(matchingEmailAddress: query), keysToFetch: keys)
        }
        for c in found where !seen.contains(c.identifier) {
            seen.insert(c.identifier)
            out.append(shape(c))
            if out.count >= limit { break }
        }
    } catch {
        return ["error": "fetch", "message": error.localizedDescription, "status": statusName()]
    }
    return ["contacts": out]
}

/// `wait`: the one-shot CLI waits for the user to answer the dialog; serve mode does not.
func contacts(_ q: String, limit: Int, wait: Bool) -> [String: Any] {
    switch statusName() {
    case "authorized", "limited":
        return search(q, limit: limit)
    case "notDetermined":
        if !wait {
            store.requestAccess(for: .contacts) { _, _ in }
            return ["error": "asking", "status": "notDetermined"]
        }
        let done = DispatchSemaphore(value: 0)
        var granted = false
        store.requestAccess(for: .contacts) { ok, _ in granted = ok; done.signal() }
        done.wait()
        return granted ? search(q, limit: limit) : ["error": "denied", "status": statusName()]
    case let s:
        return ["error": "denied", "status": s]
    }
}

// MARK: dictionary

func define(_ word: String) -> [String: Any] {
    let w = word.trimmingCharacters(in: .whitespacesAndNewlines)
    let ns = w as NSString
    guard ns.length > 0,
          let def = DCSCopyTextDefinition(nil, w as CFString, CFRange(location: 0, length: ns.length))?.takeRetainedValue() as String?
    else { return ["word": w, "definition": NSNull()] }
    var text = def.trimmingCharacters(in: .whitespacesAndNewlines)
    if text.count > 600 { text = String(text.prefix(600)).trimmingCharacters(in: .whitespaces) + "..." }
    return ["word": w, "definition": text]
}

// MARK: icons
//
// {"op":"icons","items":[{"key","kind","path"?,"target"?,"contact"?}],"size":64,"dir":"<cache>"}
// answers {"icons":{"<key>":"<png path>"|null}}. Each PNG is size x size pixels (size/2 points
// at 2x) with alpha, written to <dir>/<first 32 hex of sha256(key)>.png, so the caller can find
// a file again by hashing the same key. Sources by kind:
//   app, file, folder   the system icon for the path; images and PDFs get a QuickLook thumbnail
//                       when one comes within THUMB_WAIT, else the type icon
//   setting             "target" is an x-apple.systempreferences: URL; its extension id is looked
//                       up among the .appex bundles System Settings loads, and that bundle's icon
//                       is the pane's icon. Unknown ids get System Settings' own icon.
//   contact             "contact" is a CNContact id; its thumbnail only if access is already
//                       granted. This never asks: no access, or no photo, answers null.

let THUMB_WAIT: Double = 0.3
let SETTINGS_APP = "/System/Applications/System Settings.app"

func iconName(_ key: String) -> String {
    let digest = SHA256.hash(data: Data(key.utf8))
    return String(digest.map { String(format: "%02x", $0) }.joined().prefix(32)) + ".png"
}

/// Settings extension id -> its .appex path. Read once, on the first settings icon.
let paneBundles: [String: String] = {
    var map: [String: String] = [:]
    let dirs = ["/System/Library/ExtensionKit/Extensions", SETTINGS_APP + "/Contents/PlugIns", SETTINGS_APP + "/Contents/Extensions"]
    for dir in dirs {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir) else { continue }
        for n in names where n.hasSuffix(".appex") {
            let p = dir + "/" + n
            if let info = NSDictionary(contentsOfFile: p + "/Contents/Info.plist"), let id = info["CFBundleIdentifier"] as? String, map[id] == nil {
                map[id] = p
            }
        }
    }
    return map
}()

func paneBundle(_ target: String) -> String {
    var id = target
    if let colon = id.firstIndex(of: ":") { id = String(id[id.index(after: colon)...]) }
    if let q = id.firstIndex(of: "?") { id = String(id[..<q]) }
    return paneBundles[id] ?? SETTINGS_APP
}

func thumbnail(_ path: String, px: Int) -> NSImage? {
    let url = URL(fileURLWithPath: path)
    guard let type = UTType(filenameExtension: url.pathExtension), type.conforms(to: .image) || type.conforms(to: .pdf) else { return nil }
    let req = QLThumbnailGenerator.Request(fileAt: url, size: CGSize(width: px / 2, height: px / 2), scale: 2, representationTypes: .thumbnail)
    let done = DispatchSemaphore(value: 0)
    var image: NSImage?
    let lock = NSLock()
    QLThumbnailGenerator.shared.generateBestRepresentation(for: req) { rep, _ in
        lock.lock(); image = rep?.nsImage; lock.unlock()
        done.signal()
    }
    if done.wait(timeout: .now() + THUMB_WAIT) == .timedOut { QLThumbnailGenerator.shared.cancel(req); return nil }
    lock.lock(); defer { lock.unlock() }
    return image
}

func contactImage(_ id: String) -> NSImage? {
    let s = statusName()
    guard s == "authorized" || s == "limited" else { return nil }
    let c = try? store.unifiedContact(withIdentifier: id, keysToFetch: [CNContactThumbnailImageDataKey as CNKeyDescriptor])
    guard let data = c?.thumbnailImageData else { return nil }
    return NSImage(data: data)
}

/// The image drawn into a px x px RGBA bitmap: `fill` crops to the square (photos), otherwise
/// the image fits inside it, centred (icons, thumbnails of any aspect).
func png(_ img: NSImage, px: Int, fill: Bool) -> Data? {
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px, bitsPerSample: 8, samplesPerPixel: 4,
                                     hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let ctx = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
    // Drawn in pixels: the context takes the bitmap's size when it is made, so a point size set
    // afterwards shrank every icon into the bottom-left quarter.
    let pt = CGFloat(px)
    let w = max(img.size.width, 1), h = max(img.size.height, 1)
    let k = fill ? max(pt / w, pt / h) : min(pt / w, pt / h)
    let rect = NSRect(x: (pt - w * k) / 2, y: (pt - h * k) / 2, width: w * k, height: h * k)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = ctx
    ctx.imageInterpolation = .high
    img.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1)
    ctx.flushGraphics()
    NSGraphicsContext.restoreGraphicsState()
    return rep.representation(using: .png, properties: [:])
}

func icon(_ item: [String: Any], px: Int, dir: String) -> String? {
    guard let key = item["key"] as? String, !key.isEmpty else { return nil }
    let kind = item["kind"] as? String ?? ""
    var img: NSImage?
    var fill = false
    switch kind {
    case "app", "file", "folder":
        guard let path = item["path"] as? String, path.hasPrefix("/"), FileManager.default.fileExists(atPath: path) else { return nil }
        if kind == "file" { img = thumbnail(path, px: px) }
        if img == nil { img = NSWorkspace.shared.icon(forFile: path) }
    case "setting":
        let path = (item["path"] as? String) ?? paneBundle(item["target"] as? String ?? key)
        img = NSWorkspace.shared.icon(forFile: path)
    case "contact":
        guard let id = item["contact"] as? String, !id.isEmpty else { return nil }
        img = contactImage(id)
        fill = true
    default:
        return nil
    }
    guard let image = img, let data = png(image, px: px, fill: fill) else { return nil }
    let out = URL(fileURLWithPath: dir).appendingPathComponent(iconName(key))
    do { try data.write(to: out, options: .atomic) } catch { return nil }
    return out.path
}

func icons(_ req: [String: Any]) -> [String: Any] {
    guard let dir = req["dir"] as? String, dir.hasPrefix("/") else { return ["error": "no dir"] }
    let px = min(max((req["size"] as? Int) ?? 64, 8), 512)
    let items = Array(((req["items"] as? [[String: Any]]) ?? []).prefix(100))
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    var paths = [String?](repeating: nil, count: items.count)
    let lock = NSLock()
    DispatchQueue.concurrentPerform(iterations: items.count) { i in
        let p = autoreleasepool { icon(items[i], px: px, dir: dir) }
        lock.lock(); paths[i] = p; lock.unlock()
    }
    var out: [String: Any] = [:]
    for (i, item) in items.enumerated() { if let k = item["key"] as? String { out[k] = paths[i] ?? NSNull() } }
    return ["icons": out]
}

// MARK: clipboard
//
// macOS has no pasteboard notification, so the watcher polls the pasteboard's changeCount, one
// integer read, every CLIP_MS (with a third of that as timer leeway so the system can coalesce the
// wakeups). This is the only thing the helper does while the Capsule is hidden, so a tick that
// finds no change does nothing else: no read of the contents, no allocation, no output. Only when
// the count moves does it read the new item, once.
//
//   {"op":"clip.watch","on":true,"ms"?:750}   answers {"watching":true,"count":N}; "on":false stops
//   {"op":"clip.write","text":"..."}           or "files":["/abs/path",...]; answers {"ok":true,"count":N}
//   {"event":"clip","item":{...}}              unsolicited, one per new item the watcher records
//
// An item is {"count","at"(ms),"app"?, and one of "text" (with "truncated" when cut),
// "files" (paths), or "image":true (a note only; no image data leaves the pasteboard)}.
//
// Never recorded, and never even read past its type list: items marked concealed, transient or
// auto-generated (nspasteboard.org), 1Password's marker, Universal Clipboard items from another
// device (reading one makes macOS fetch it over the air, and phone password managers do not
// always mark them), anything copied while a password manager is the front app, and the
// Capsule's own writes, which carry OWN_TYPE. clip.write also moves the watcher past its own
// count, so a pick never comes back as a new item.
//
// Tests pass "board":"vyre-..." to use a private named pasteboard instead of the general one.
// Three ops exist only for that and refuse the general pasteboard: clip.put (write raw types),
// clip.peek (read as the watcher would) and clip.release.

let CLIP_MS = 750
let CLIP_TEXT_MAX = 20_000
let OWN_TYPE = NSPasteboard.PasteboardType("run.vyre.clip")
let SKIP_TYPES: Set<String> = [
    "org.nspasteboard.ConcealedType", "org.nspasteboard.TransientType", "org.nspasteboard.AutoGeneratedType",
    "com.agilebits.onepassword", "com.apple.is-remote-clipboard", "de.petermaurer.TransientPasteboardType",
    "Pasteboard generator type", "net.antelle.keeweb",
]
let SKIP_APPS: Set<String> = [
    "com.1password.1password", "com.agilebits.onepassword7", "com.agilebits.onepassword-osx", "com.bitwarden.desktop",
    "com.apple.keychainaccess", "com.apple.Passwords", "org.keepassxc.keepassxc", "com.lastpass.LastPass",
    "in.sinew.Enpass-Desktop", "com.dashlane.dashlanephonefinal", "com.nordpass.macos.NordPass",
]

// Watcher state. Touched on the main queue only.
var clipTimer: DispatchSourceTimer?
var clipBoard = NSPasteboard.general
var clipSeen = 0

/// The pasteboard a request names: the general one, or a private "vyre-" named one for tests.
func pasteboard(_ req: [String: Any], named: Bool = false) -> NSPasteboard? {
    if let name = req["board"] as? String, !name.isEmpty {
        guard name.hasPrefix("vyre-") else { return nil }
        return NSPasteboard(name: NSPasteboard.Name(name))
    }
    return named ? nil : .general
}

/// The item on `pb` as the watcher records it, or nil and why it was skipped.
func readClip(_ pb: NSPasteboard, app: NSRunningApplication?) -> ([String: Any]?, String) {
    let types = (pb.types ?? []).map { $0.rawValue }
    if types.isEmpty { return (nil, "empty") }
    if types.contains(OWN_TYPE.rawValue) { return (nil, "own") }
    if types.contains(where: { SKIP_TYPES.contains($0) }) { return (nil, "marked") }
    if let b = app?.bundleIdentifier, SKIP_APPS.contains(b) { return (nil, "app") }
    var item: [String: Any] = ["count": pb.changeCount, "at": Int(Date().timeIntervalSince1970 * 1000)]
    if let n = app?.localizedName, !n.isEmpty { item["app"] = n }
    if types.contains(NSPasteboard.PasteboardType.fileURL.rawValue),
       let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
        item["files"] = urls.prefix(50).map { $0.path }
    } else if let s = pb.string(forType: .string), !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        if s.count > CLIP_TEXT_MAX { item["text"] = String(s.prefix(CLIP_TEXT_MAX)); item["truncated"] = true }
        else { item["text"] = s }
    } else if types.contains(where: { UTType($0)?.conforms(to: .image) ?? false }) {
        item["image"] = true
    } else {
        return (nil, "unsupported")
    }
    return (item, "")
}

func clipTick() {
    let n = clipBoard.changeCount
    if n == clipSeen { return }
    clipSeen = n
    let (item, _) = autoreleasepool { readClip(clipBoard, app: NSWorkspace.shared.frontmostApplication) }
    if let item = item { emit(["event": "clip", "item": item]) }
}

func clipWatch(_ req: [String: Any]) -> [String: Any] {
    clipTimer?.cancel()
    clipTimer = nil
    guard (req["on"] as? Bool) ?? true else { return ["watching": false] }
    guard let pb = pasteboard(req) else { return ["error": "bad board"] }
    let ms = min(max((req["ms"] as? Int) ?? CLIP_MS, 100), 5000)
    clipBoard = pb
    clipSeen = pb.changeCount              // what is already there when watching starts is not new
    let t = DispatchSource.makeTimerSource(queue: .main)
    t.schedule(deadline: .now() + .milliseconds(ms), repeating: .milliseconds(ms), leeway: .milliseconds(ms / 3))
    t.setEventHandler { clipTick() }
    t.resume()
    clipTimer = t
    return ["watching": true, "count": clipSeen]
}

/// The user's explicit pick, written to the pasteboard. Pasting it is the user's own Command-V.
func clipWrite(_ req: [String: Any]) -> [String: Any] {
    guard let pb = pasteboard(req) else { return ["error": "bad board"] }
    let text = req["text"] as? String ?? ""
    let files = ((req["files"] as? [String]) ?? []).filter { $0.hasPrefix("/") && FileManager.default.fileExists(atPath: $0) }
    if text.isEmpty && files.isEmpty { return ["error": "nothing to write"] }
    pb.clearContents()
    if files.isEmpty {
        pb.setString(text, forType: .string)
    } else {
        pb.writeObjects(files.map { URL(fileURLWithPath: $0) as NSURL })
    }
    pb.setData(Data(), forType: OWN_TYPE)
    let n = pb.changeCount
    if pb.name == clipBoard.name { clipSeen = n }
    return ["ok": true, "count": n]
}

/// Tests only: raw types onto a private named pasteboard, as another app would write them.
func clipPut(_ req: [String: Any]) -> [String: Any] {
    guard let pb = pasteboard(req, named: true) else { return ["error": "a vyre- board is required"] }
    let types = (req["types"] as? [String: String]) ?? [:]
    pb.clearContents()
    pb.declareTypes(types.keys.map { NSPasteboard.PasteboardType($0) }, owner: nil)
    for (k, v) in types { pb.setString(v, forType: NSPasteboard.PasteboardType(k)) }
    return ["ok": true, "count": pb.changeCount]
}

func clipPeek(_ req: [String: Any]) -> [String: Any] {
    guard let pb = pasteboard(req, named: true) else { return ["error": "a vyre- board is required"] }
    let (item, why) = readClip(pb, app: nil)
    return item.map { ["item": $0] } ?? ["item": NSNull(), "skipped": why]
}

func clipRelease(_ req: [String: Any]) -> [String: Any] {
    guard let pb = pasteboard(req, named: true) else { return ["error": "a vyre- board is required"] }
    if pb.name == clipBoard.name { clipTimer?.cancel(); clipTimer = nil; clipBoard = .general }
    pb.releaseGlobally()
    return ["ok": true]
}

func clipOp(_ op: String, _ req: [String: Any]) -> [String: Any] {
    switch op {
    case "clip.watch": return clipWatch(req)
    case "clip.write": return clipWrite(req)
    case "clip.put": return clipPut(req)
    case "clip.peek": return clipPeek(req)
    case "clip.release": return clipRelease(req)
    default: return ["error": "unknown op"]
    }
}

// MARK: entry

let args = Array(CommandLine.arguments.dropFirst())

func limitArg() -> Int {
    if let i = args.firstIndex(of: "--limit"), i + 1 < args.count, let n = Int(args[i + 1]), n > 0 { return n }
    return 8
}

switch args.first {
case "contacts":
    if args.contains("--status") { emit(["status": statusName()]); exit(0) }
    var rest = Array(args.dropFirst())
    if let i = rest.firstIndex(of: "--limit") { rest.removeSubrange(i...min(i + 1, rest.count - 1)) }
    emit(contacts(rest.joined(separator: " "), limit: limitArg(), wait: true))
    exit(0)
case "define":
    emit(define(args.dropFirst().joined(separator: " ")))
    exit(0)
case "serve":
    // Requests are read on a thread of their own so the main thread can run its run loop: the
    // clipboard timer fires there, and NSWorkspace keeps frontmostApplication current only for a
    // process whose main run loop turns. Clipboard ops run on the main queue, beside the watcher
    // state they share; every other op runs concurrently off it.
    let work = DispatchQueue(label: "run.vyre.local.work", attributes: .concurrent)
    let group = DispatchGroup()
    Thread.detachNewThread {
        while let line = readLine() {
            guard let data = line.data(using: .utf8),
                  let req = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                if !line.trimmingCharacters(in: .whitespaces).isEmpty { emit(["error": "bad request"]) }
                continue
            }
            let id = req["id"] ?? NSNull()
            let q = req["q"] as? String ?? ""
            let limit = (req["limit"] as? Int).map { max(1, $0) } ?? 8
            let op = req["op"] as? String ?? ""
            if op == "front" {
                // For opens that do not come through the hotkey (menu, CLI): which app was in front
                // before the Capsule shows. Read on the main queue, whose run loop keeps it current.
                // It asks macOS for no permission.
                DispatchQueue.main.async(group: group) {
                    var ans: [String: Any] = ["front": NSNull()]
                    if let a = NSWorkspace.shared.frontmostApplication {
                        ans["front"] = ["bundle": a.bundleIdentifier ?? "", "pid": Int(a.processIdentifier), "name": a.localizedName ?? ""]
                    }
                    ans["id"] = id
                    emit(ans)
                }
                continue
            }
            if op.hasPrefix("clip.") {
                DispatchQueue.main.async(group: group) {
                    var ans = autoreleasepool { clipOp(op, req) }
                    ans["id"] = id
                    emit(ans)
                }
                continue
            }
            work.async(group: group) {
                var ans: [String: Any]
                switch op {
                case "status": ans = ["status": statusName()]
                case "contacts": ans = contacts(q, limit: limit, wait: false)
                case "define": ans = define(q)
                case "icons": ans = icons(req)
                default: ans = ["error": "unknown op"]
                }
                ans["id"] = id
                emit(ans)
            }
        }
        group.wait()
        exit(0)
    }
    RunLoop.main.run()
default:
    FileHandle.standardError.write("usage: local contacts --status | contacts <query> [--limit N] | define <word> | serve\n".data(using: .utf8)!)
    emit(["error": "usage"])
    exit(64)
}
